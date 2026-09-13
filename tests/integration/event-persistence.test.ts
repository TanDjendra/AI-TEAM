/**
 * Event bus, transports and the event -> persistence pipeline.
 * Real Postgres for storage; transports verified against stubs that record what
 * they receive (a transport is a boundary, not core logic).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, resetTestDb, seedAgents, seedTask, type TestDb } from "./helpers/test-db.js";
import { createEventBus, makeEvent, type EventBus } from "../../src/events/bus.js";
import {
  CompositeEventTransport,
  InMemoryEventTransport,
  SupabaseRealtimeEventTransport,
  WebSocketEventTransport,
  type SupabaseRealtimeClient,
  type WebSocketLike,
} from "../../src/events/transports.js";
import { createEventRecorder, type EventRecorder } from "../../src/persistence/repositories/event-recorder.js";
import { createLogger } from "../../src/domain/logger.js";
import type { AnyTaskEvent, TaskEventPayloadMap, TaskEventType } from "../../src/events/types.js";

let testDb: TestDb;
const logger = createLogger({ level: "error", sink: () => {} });

beforeAll(async () => {
  testDb = await createTestDb();
}, 60_000);

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await resetTestDb(testDb);
});

/** Deterministic ids/timestamps so ordering assertions are meaningful. */
function deterministicBus(options: { onError?: (failure: unknown) => void } = {}) {
  let counter = 0;
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  return {
    bus: createEventBus({
      newId: () => `evt-${++counter}`,
      now: () => new Date((clock += 1000)),
      ...(options.onError ? { onError: options.onError as never } : {}),
    }),
    nextId: () => `evt-${counter + 1}`,
    tick: (ms = 1000) => (clock += ms),
  };
}

/**
 * Builds a test event.
 *
 * The payload is typed as `never` at the call site on purpose: this helper is
 * the test's own escape hatch for constructing arbitrary events, and every call
 * is validated at runtime by the repositories that consume it. The alternative
 * (a generic that infers K from the literal) makes multi-event test bodies
 * unreadable.
 */
function event<K extends TaskEventType>(
  type: K,
  taskId: string,
  payload: TaskEventPayloadMap[K],
  extra: { id?: string; agentId?: string; cycle?: number } = {},
): AnyTaskEvent {
  return makeEvent({
    type,
    taskId,
    payload,
    ...(extra.id ? { id: extra.id } : {}),
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
    ...(extra.cycle === undefined ? {} : { cycle: extra.cycle }),
  }) as AnyTaskEvent;
}

describe("EventBus", () => {
  it("delivers to subscribers and transports", async () => {
    const { bus } = deterministicBus();
    const transport = new InMemoryEventTransport();
    bus.addTransport(transport);

    const seen: AnyTaskEvent[] = [];
    bus.subscribe((e) => {
      seen.push(e);
    });

    await bus.publish(event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 }));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe("TASK_STARTED");
    expect(transport.count()).toBe(1);
    expect(bus.stats().published).toBe(1);
  });

  it("keeps delivering when one subscriber throws", async () => {
    const failures: unknown[] = [];
    const { bus } = deterministicBus({ onError: (f) => failures.push(f) });
    const transport = new InMemoryEventTransport();
    bus.addTransport(transport);

    const good: string[] = [];
    bus.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    bus.subscribe((e) => {
      good.push(e.type);
    });

    await bus.publish(event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 }));

    expect(good).toEqual(["TASK_STARTED"]);
    expect(transport.count()).toBe(1);
    expect(failures).toHaveLength(1);
    expect(bus.stats().failures).toBe(1);
  });

  it("keeps delivering when one transport fails", async () => {
    const failures: Array<{ source: string }> = [];
    const { bus } = deterministicBus({ onError: (f) => failures.push(f as { source: string }) });

    const healthy = new InMemoryEventTransport();
    bus.addTransport({
      name: "broken",
      publish: async () => {
        throw new Error("sink down");
      },
    });
    bus.addTransport(healthy);

    await bus.publish(event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 }));

    // The failure is reported, not thrown, and the healthy sink still got it.
    expect(failures.some((f) => f.source === "broken")).toBe(true);
    expect(healthy.count()).toBe(1);
  });

  it("replays recent events and filters by type", async () => {
    const { bus } = deterministicBus();
    await bus.publish(event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 }));
    await bus.publish(
      event("TASK_APPROVED", "TASK-1", { cycle: 1, severity: "NONE", reviewer: "r" }),
    );

    expect(bus.recent()).toHaveLength(2);
    expect(bus.recent(1)).toHaveLength(1);
    expect(bus.recentOfType(["TASK_APPROVED"])).toHaveLength(1);
  });

  it("waitFor resolves against history and against future events", async () => {
    const { bus } = deterministicBus();
    await bus.publish(event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 }));

    await expect(bus.waitFor((e) => e.type === "TASK_STARTED", { timeoutMs: 500 })).resolves.toMatchObject(
      { type: "TASK_STARTED" },
    );

    const pending = bus.waitFor((e) => e.type === "TASK_APPROVED", { timeoutMs: 2_000 });
    await bus.publish(event("TASK_APPROVED", "TASK-1", { cycle: 1, severity: "NONE", reviewer: "r" }));
    await expect(pending).resolves.toMatchObject({ type: "TASK_APPROVED" });
  });

  it("waitFor times out instead of hanging", async () => {
    const { bus } = deterministicBus();
    await expect(
      bus.waitFor((e) => e.type === "TASK_CANCELLED", { timeoutMs: 50 }),
    ).rejects.toThrow(/Timed out/);
  });

  it("removes transports", async () => {
    const { bus } = deterministicBus();
    const transport = new InMemoryEventTransport();
    bus.addTransport(transport);
    expect(bus.removeTransport("in-memory")).toBe(true);
    expect(bus.removeTransport("in-memory")).toBe(false);

    await bus.publish(event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 }));
    expect(transport.count()).toBe(0);
  });

  it("is idempotent when the same event object is republished (recorder dedupes)", async () => {
    const { bus } = deterministicBus();
    const task = await seedTask(testDb);
    const recorder = attachRecorder(bus);

    const same = event("TASK_STARTED", task.externalId, { workspace: "/ws", maxReviewCycles: 3 }, { id: "fixed-id" });
    await bus.publish(same);
    await bus.publish(same);

    const logs = await testDb.activityLogs.listForTask(task.id);
    expect(logs.filter((log) => log.eventId === "fixed-id")).toHaveLength(1);
    expect(recorder.stats().duplicates).toBeGreaterThanOrEqual(1);
  });
});

describe("transports", () => {
  it("InMemoryEventTransport notifies local subscribers", async () => {
    const transport = new InMemoryEventTransport();
    const seen: string[] = [];
    transport.subscribe((e) => seen.push(e.type));

    await transport.publish(event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 }));
    expect(seen).toEqual(["TASK_STARTED"]);
  });

  it("WebSocketEventTransport queues while closed and flushes when open", async () => {
    const sent: string[] = [];
    const socket: WebSocketLike = {
      readyState: 0,
      send: (data) => sent.push(data),
      close: () => {
        socket.readyState = 3;
      },
    };
    const transport = new WebSocketEventTransport({ connect: () => socket });

    await transport.publish(event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 }));
    expect(sent).toHaveLength(0);
    expect(transport.pending()).toBe(1);

    // The socket opens; queued events flush.
    socket.readyState = 1;
    socket.on?.("open", () => {});
    await transport.publish(event("TASK_APPROVED", "TASK-1", { cycle: 1, severity: "NONE", reviewer: "r" }));

    expect(transport.pending()).toBe(0);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(sent[0]!).type).toBe("TASK_STARTED");

    await transport.close();
  });

  it("WebSocketEventTransport bounds its queue", async () => {
    const socket: WebSocketLike = { readyState: 0, send: () => {}, close: () => {} };
    const transport = new WebSocketEventTransport({ connect: () => socket, maxQueue: 2 });

    for (let i = 0; i < 5; i++) {
      await transport.publish(
        event("TASK_STARTED", `TASK-${i}`, { workspace: "/ws", maxReviewCycles: 3 }, { id: `e${i}` }),
      );
    }

    // Oldest dropped, newest kept.
    expect(transport.pending()).toBe(2);
    await transport.close();
  });

  it("SupabaseRealtimeEventTransport broadcasts to its channel", async () => {
    const broadcasts: Array<{ event: string; payload: { type?: string } }> = [];
    const client: SupabaseRealtimeClient = {
      channel: () => ({
        send: async (args) => {
          broadcasts.push({ event: args.event, payload: args.payload as { type?: string } });
        },
      }),
    };
    const transport = new SupabaseRealtimeEventTransport({ client, channel: "team" });

    await transport.publish(event("TASK_APPROVED", "TASK-1", { cycle: 1, severity: "NONE", reviewer: "r" }));

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.event).toBe("task_event");
    expect(broadcasts[0]!.payload.type).toBe("TASK_APPROVED");
    expect(transport.failureCount()).toBe(0);
  });

  it("SupabaseRealtimeEventTransport reports a failing send", async () => {
    const client: SupabaseRealtimeClient = {
      channel: () => ({
        send: async () => {
          throw new Error("channel closed");
        },
      }),
    };
    const transport = new SupabaseRealtimeEventTransport({ client });

    await expect(
      transport.publish(event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 })),
    ).rejects.toThrow(/channel closed/);
    expect(transport.failureCount()).toBe(1);
  });

  it("redacts secrets before they reach a transport", async () => {
    const received: string[] = [];
    const client: SupabaseRealtimeClient = {
      channel: () => ({
        send: async (args) => {
          received.push(JSON.stringify(args.payload));
        },
      }),
    };
    const transport = new SupabaseRealtimeEventTransport({ client });

    await transport.publish(
      event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 }, { id: "x" }),
    );
    // A payload that contains a credential-shaped value. Cast through unknown:
    // this deliberately violates the payload contract to prove redaction holds
    // even for a payload that should never have been constructed that way.
    await transport.publish({
      ...event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 }, { id: "y" }),
      payload: { workspace: "/ws", maxReviewCycles: 3, apiKey: "sk-live-abcdef1234567890" },
    } as unknown as AnyTaskEvent);

    expect(received.join("\n")).not.toContain("sk-live-abcdef1234567890");
    expect(received.join("\n")).toContain("[REDACTED]");
  });

  it("CompositeEventTransport tolerates one failing sink", async () => {
    const healthy = new InMemoryEventTransport();
    const composite = new CompositeEventTransport([
      { name: "bad", publish: async () => Promise.reject(new Error("nope")) },
      healthy,
    ]);

    await composite.publish(event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 }));
    expect(healthy.count()).toBe(1);
  });

  it("CompositeEventTransport surfaces the error when every sink fails", async () => {
    const composite = new CompositeEventTransport([
      { name: "bad-1", publish: async () => Promise.reject(new Error("a")) },
      { name: "bad-2", publish: async () => Promise.reject(new Error("b")) },
    ]);

    await expect(
      composite.publish(event("TASK_STARTED", "TASK-1", { workspace: "/ws", maxReviewCycles: 3 })),
    ).rejects.toThrow();
  });
});

/** Helper: attaches a recorder to a bus with the test repositories. */
function attachRecorder(bus: EventBus, options: { onFatal?: (m: string) => void } = {}): EventRecorder {
  const recorder = createEventRecorder({
    repositories: {
      tasks: testDb.tasks,
      agents: testDb.agents,
      runs: testDb.runs,
      reviews: testDb.reviews,
      activityLogs: testDb.activityLogs,
      toolCalls: testDb.toolCalls,
      fileChanges: testDb.fileChanges,
      testResults: testDb.testResults,
      interrupts: testDb.interrupts,
    },
    logger,
    ...(options.onFatal ? { onFailure: (f) => f.fatal && options.onFatal!(f.message) } : {}),
  });
  recorder.attach(bus);
  return recorder;
}

export { attachRecorder };

describe("EventRecorder -> database", () => {
  it("persists activity logs in order", async () => {
    const { bus } = deterministicBus();
    const task = await seedTask(testDb);
    attachRecorder(bus);

    await bus.publish(event("TASK_STARTED", task.externalId, { workspace: "/ws", maxReviewCycles: 3 }));
    await bus.publish(
      event("STATE_CHANGED", task.externalId, { from: "PENDING", to: "CODING", cycle: 0 }),
    );
    await bus.publish(
      event("STATE_CHANGED", task.externalId, { from: "CODING", to: "TESTING", cycle: 0 }),
    );

    const logs = await testDb.activityLogs.listForTask(task.id);
    expect(logs.map((log) => log.eventType)).toEqual([
      "TASK_STARTED",
      "STATE_CHANGED",
      "STATE_CHANGED",
    ]);
    // Ordering is by occurred_at, so the payloads match the publish order.
    expect(logs[1]!.payload).toMatchObject({ to: "CODING" });
    expect(logs[2]!.payload).toMatchObject({ to: "TESTING" });
  });

  it("projects AGENT_STARTED / AGENT_FINISHED onto agents.status", async () => {
    const { bus } = deterministicBus();
    const { coderId } = await seedAgents(testDb);
    const task = await seedTask(testDb);
    const recorder = attachRecorder(bus);
    recorder.registerRunContext({
      externalTaskId: task.externalId,
      taskId: task.id,
      runKey: "run-1",
      agentKeys: { "coder-agent": coderId },
    });

    await bus.publish(
      event(
        "AGENT_STARTED",
        task.externalId,
        { agentId: "coder-agent", role: "coder", model: "m", cycle: 1, attempt: 1, runReason: "INITIAL" },
        { agentId: "coder-agent", cycle: 1 },
      ),
    );
    expect((await testDb.agents.findById(coderId))?.status).toBe("WORKING");

    await bus.publish(
      event(
        "AGENT_FINISHED",
        task.externalId,
        { agentId: "coder-agent", role: "coder", ok: true, durationMs: 10 },
        { agentId: "coder-agent", cycle: 1 },
      ),
    );
    expect((await testDb.agents.findById(coderId))?.status).toBe("IDLE");
  });

  it("projects TOOL_STARTED / TOOL_FINISHED with exit code and truncated output", async () => {
    const { bus } = deterministicBus();
    const { coderId } = await seedAgents(testDb);
    const task = await seedTask(testDb);
    const recorder = attachRecorder(bus);
    recorder.registerRunContext({
      externalTaskId: task.externalId,
      taskId: task.id,
      runKey: "run-1",
      agentKeys: { "coder-agent": coderId },
    });

    await bus.publish(
      event(
        "TOOL_STARTED",
        task.externalId,
        { toolCallId: "call-1", tool: "run_command", arguments: { command: "npm test" }, agentId: "coder-agent", cycle: 1 },
        { agentId: "coder-agent", cycle: 1 },
      ),
    );
    await bus.publish(
      event(
        "TOOL_FINISHED",
        task.externalId,
        {
          toolCallId: "call-1",
          tool: "run_command",
          agentId: "coder-agent",
          cycle: 1,
          success: true,
          durationMs: 120,
          exitCode: 0,
          outputSummary: `${"x".repeat(5_000)}END`,
        },
        { agentId: "coder-agent", cycle: 1 },
      ),
    );

    const calls = await testDb.toolCalls.listForTask(task.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("run_command");
    expect(calls[0]!.arguments).toEqual({ command: "npm test" });
    expect(calls[0]!.success).toBe(true);
    expect(calls[0]!.exitCode).toBe(0);
    // Bounded, with the tail preserved.
    expect(calls[0]!.outputSummary!.length).toBeLessThan(5_000);
    expect(calls[0]!.outputSummary).toContain("END");
    expect(calls[0]!.outputSummary).toContain("omitted");
  });

  it("never stores a credential from tool arguments", async () => {
    const { bus } = deterministicBus();
    const task = await seedTask(testDb);
    const recorder = attachRecorder(bus);
    recorder.registerRunContext({ externalTaskId: task.externalId, taskId: task.id, runKey: "run-1" });

    await bus.publish(
      event("TOOL_STARTED", task.externalId, {
        toolCallId: "call-secret",
        tool: "run_command",
        arguments: { command: "curl", authorization: "Bearer sk-live-abcdef1234567890", apiKey: "grip-0123456789abcdef" },
        agentId: "coder-agent",
        cycle: 1,
      }),
    );

    const calls = await testDb.toolCalls.listForTask(task.id);
    const serialised = JSON.stringify(calls[0]!.arguments);
    expect(serialised).not.toContain("sk-live-abcdef1234567890");
    expect(serialised).not.toContain("grip-0123456789abcdef");
    expect(serialised).toContain("[REDACTED]");
  });

  it("projects FILE_CHANGED and keeps one row per path", async () => {
    const { bus } = deterministicBus();
    const task = await seedTask(testDb);
    const recorder = attachRecorder(bus);
    recorder.registerRunContext({ externalTaskId: task.externalId, taskId: task.id, runKey: "run-1" });

    await bus.publish(
      event("FILE_CHANGED", task.externalId, {
        agentId: "coder-agent",
        path: "src/index.js",
        changeType: "created",
        summary: "created",
      }),
    );
    await bus.publish(
      event("FILE_CHANGED", task.externalId, {
        agentId: "coder-agent",
        path: "src/index.js",
        changeType: "modified",
        summary: "modified",
      }),
    );
    await bus.publish(
      event("FILE_CHANGED", task.externalId, {
        agentId: "coder-agent",
        path: "test/index.test.js",
        changeType: "created",
        summary: "created",
      }),
    );

    const changes = await testDb.fileChanges.listForTask(task.id);
    expect(changes).toHaveLength(2);
    expect(changes.find((c) => c.path === "src/index.js")?.changeType).toBe("modified");
    // Paths only — never the file body.
    expect(JSON.stringify(changes)).not.toContain("function");
  });

  it("keeps one authoritative test result and the rest as history", async () => {
    const { bus } = deterministicBus();
    const task = await seedTask(testDb);
    const recorder = attachRecorder(bus);
    recorder.registerRunContext({ externalTaskId: task.externalId, taskId: task.id, runKey: "run-1" });

    const publishTest = (command: string, passed: boolean, authoritative: boolean, id: string) =>
      bus.publish(
        event(
          "TEST_FINISHED",
          task.externalId,
          {
            agentId: "coder-agent",
            testKey: id,
            command,
            cycle: 1,
            exitCode: passed ? 0 : 1,
            passed,
            durationMs: 5,
            outputSummary: passed ? "# pass 3" : "# fail 1",
            authoritative,
          },
          { id, cycle: 1 },
        ),
      );

    await publishTest("node --test broken", false, false, "t1");
    await publishTest("node --test", true, true, "t2");
    await publishTest("npm test", true, true, "t3");

    const authoritative = await testDb.testResults.authoritative(task.id);
    expect(authoritative?.command).toBe("npm test");
    expect(authoritative?.passed).toBe(true);

    const history = await testDb.testResults.historyForTask(task.id);
    expect(history.map((row) => row.command)).toEqual(["node --test broken"]);
  });

  it("persists reviews and never overwrites an earlier cycle", async () => {
    const { bus } = deterministicBus();
    const task = await seedTask(testDb);
    const recorder = attachRecorder(bus);
    recorder.registerRunContext({ externalTaskId: task.externalId, taskId: task.id, runKey: "run-1" });

    const publishReview = (cycle: number, verdict: "APPROVED" | "REJECTED", id: string) =>
      bus.publish(
        event(
          "REVIEW_FINISHED",
          task.externalId,
          {
            reviewer: "reviewer-agent",
            cycle,
            verdict,
            severity: verdict === "APPROVED" ? "NONE" : "HIGH",
            issues: verdict === "APPROVED" ? [] : ["missing edge case"],
            requiredFixes: verdict === "APPROVED" ? [] : ["handle empty input"],
            summary: `cycle ${cycle}`,
          },
          { id, cycle },
        ),
      );

    await publishReview(1, "REJECTED", "r1");
    await publishReview(2, "APPROVED", "r2");

    const reviews = await testDb.reviews.listForTask(task.id);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.verdict).toBe("REJECTED");
    expect(reviews[0]!.requiredFixes).toEqual(["handle empty input"]);
    expect(reviews[1]!.verdict).toBe("APPROVED");
    expect(await testDb.reviews.decidedCycles(task.id)).toEqual([1, 2]);
  });

  it("reports a journal failure as fatal", async () => {
    const { bus } = deterministicBus();
    const task = await seedTask(testDb);
    attachRecorder(bus, { onFatal: () => {} });

    // A task id with no matching row is fine (nullable FK), but a duplicate
    // event id that is already taken with different content is not the failure
    // mode under test; here we force a real DB error by dropping the table.
    await testDb.db.exec("alter table activity_logs rename to activity_logs_tmp");

    const fatalMessages: string[] = [];
    const recorder = attachRecorder(bus, { onFatal: (m) => fatalMessages.push(m) });
    await bus.publish(event("TASK_STARTED", task.externalId, { workspace: "/ws", maxReviewCycles: 3 }));

    expect(recorder.hasFatalFailure()).toBe(true);
    expect(fatalMessages.length).toBeGreaterThan(0);

    await testDb.db.exec("alter table activity_logs_tmp rename to activity_logs");
  });
});
