/**
 * API route integration tests.
 *
 * These call the REAL Next.js route handlers against a REAL PostgreSQL (PGlite)
 * with the REAL migrations and repositories. Two things are proven here that a
 * mocked test could not:
 *   - every HTTP endpoint the dashboard uses returns real database rows;
 *   - a control action is journaled, so it appears in the activity feed.
 *
 * The runtime is injected through the app's own test seam
 * (`installDashboardRuntime`), so the handlers run unmodified.
 */

import { beforeEach, afterAll, describe, expect, it } from "vitest";

import type { Logger } from "../../src/domain/logger.js";
import { createLogger, type LogLevel } from "../../src/domain/logger.js";
import { loadConfig } from "../../src/config/env.js";
import {
  createDashboardRuntime,
  installDashboardRuntime,
  resetDashboardRuntime,
  type DashboardRuntime,
} from "../../src/dashboard/runtime.js";
import { createRealtimeHub } from "../../src/dashboard/realtime.js";
import { createEventBus } from "../../src/events/bus.js";
import type { AnyTaskEvent } from "../../src/events/types.js";
import { createPersistence, type Persistence } from "../../src/persistence/container.js";
import { createEventRecorder } from "../../src/persistence/repositories/event-recorder.js";
import type { Db } from "../../src/persistence/db.js";

import { createTestDb, resetTestDb, seedAgents, type TestDb } from "./helpers/test-db.js";
import { ScriptedWorker, type WorkerScript } from "./helpers/scripted-worker.js";

import { GET as getAgents } from "../../app/api/agents/route.js";
import { GET as getAgent } from "../../app/api/agents/[id]/route.js";
import { GET as getTasks, POST as postTask } from "../../app/api/tasks/route.js";
import { GET as getTask } from "../../app/api/tasks/[id]/route.js";
import { GET as getAction, POST as postAction } from "../../app/api/tasks/[id]/[action]/route.js";
import { GET as getActivity } from "../../app/api/activity/route.js";
import { GET as getTaskActivity } from "../../app/api/tasks/[id]/activity/route.js";
import { GET as getReviews } from "../../app/api/reviews/route.js";
import { GET as getStatus } from "../../app/api/status/route.js";

let testDb: TestDb;
let persistence: Persistence;
let hub: ReturnType<typeof createRealtimeHub>;
let worker: ScriptedWorker;
const forwarded: AnyTaskEvent[] = [];

const ROUTER_KEY = "sk-live-abcdef0123456789";

const silentLogger: Logger = createLogger({ level: "error" as LogLevel, sink: () => {} });

function buildPersistence(db: Db, bus: ReturnType<typeof createEventBus>): Persistence {
  const repositories = {
    tasks: testDb.tasks,
    agents: testDb.agents,
    runs: testDb.runs,
    reviews: testDb.reviews,
    activityLogs: testDb.activityLogs,
    toolCalls: testDb.toolCalls,
    fileChanges: testDb.fileChanges,
    testResults: testDb.testResults,
    interrupts: testDb.interrupts,
  };

  // The REAL recorder, not a stub: this is what proves that a control action is
  // actually journalled into activity_logs, and that `PUBLIC event → row`
  // projections run end to end.
  const recorder = createEventRecorder({ repositories, logger: silentLogger });
  recorder.attach(bus);

  return {
    db,
    bus,
    recorder,
    repositories,
    transport: { name: "in-memory", publish: async () => {} },
    agentIds: {},
    agentKeys: { coder: "coder-agent", reviewer: "reviewer-agent" },
    warnings: [],
    close: async () => {},
  } as unknown as Persistence;
}

async function installRuntime(
  overrides: Partial<DashboardRuntime> = {},
  script: WorkerScript = { kind: "hold" },
): Promise<void> {
  // Minimal valid configuration for the handler under test. The router key is a
  // synthetic sentinel: nothing calls a model here, and it doubles as the value
  // the redaction assertions prove is never exposed.
  const config = loadConfig({
    env: {
      ROUTER_API_KEY: ROUTER_KEY,
      CODER_MODEL: "grip/deepseek-v4-flash",
      REVIEWER_MODEL: "grip/gpt-5.6-luna",
      ROUTER_BASE_URL: "http://localhost:20128/v1",
      DATABASE_URL: "postgres://localhost/unused-in-tests",
    },
    cwd: process.cwd(),
    loadDotEnv: false,
  });
  // The model ids must match the seeded agent rows for the assertions below.
  const configured = {
    ...config,
    coder: { model: "grip/deepseek-v4.1-flash" },
    reviewer: { model: "grip/gpt-5.6-luna" },
  };
  const runtime = await createDashboardRuntime({
    config: configured,
    logger: silentLogger,
    persistence,
    hub,
    // A scripted worker keeps these tests deterministic: no model is called, but
    // the real claim/conflict path and the real persistence still run.
    control: { worker, loadSpec: async (task) => ({ id: task.externalId, title: task.title, description: task.description }) },
    ...overrides,
  });
  installDashboardRuntime(runtime);
  void script;
}

beforeEach(async () => {
  testDb ??= await createTestDb();
  await resetTestDb(testDb);

  forwarded.length = 0;
  hub = createRealtimeHub();
  hub.addTransport({
    name: "test-capture",
    publish: async (event) => {
      forwarded.push(event);
    },
  });

  const bus = createEventBus();
  // Every published event also reaches the realtime hub, mirroring production.
  bus.addTransport({
    name: "hub-bridge",
    publish: async (event) => {
      await hub.bus.publish(event);
    },
  });
  persistence = buildPersistence(testDb.db, bus);
  await seedAgents(testDb);
  worker = new ScriptedWorker({ persistence });
  await installRuntime();
});

afterAll(async () => {
  resetDashboardRuntime();
  await testDb?.close();
});

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function actionParams(id: string, action: string): { params: Promise<{ id: string; action: string }> } {
  return { params: Promise.resolve({ id, action }) };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("GET /api/agents", () => {
  it("returns both configured agents with their real models", async () => {
    const body = await readJson<{ ok: boolean; data: Array<{ role: string; model: string; status: string }> }>(
      await getAgents(),
    );

    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    const coder = body.data.find((agent) => agent.role === "coder");
    const reviewer = body.data.find((agent) => agent.role === "reviewer");
    expect(coder?.model).toBe("grip/deepseek-v4.1-flash");
    expect(reviewer?.model).toBe("grip/gpt-5.6-luna");
    expect(coder?.status).toBe("IDLE");
  });

  it("never exposes a credential", async () => {
    const text = await (await getAgents()).text();
    expect(text).not.toContain(ROUTER_KEY);
    expect(text).not.toContain("ROUTER_API_KEY");
  });
});

describe("GET /api/agents/:id", () => {
  it("resolves by agent key", async () => {
    const body = await readJson<{ ok: boolean; data: { agent: { agentKey: string } } }>(
      await getAgent(new Request("http://localhost/api/agents/coder-agent"), params("coder-agent")),
    );
    expect(body.data.agent.agentKey).toBe("coder-agent");
  });

  it("404s an unknown agent", async () => {
    const response = await getAgent(new Request("http://localhost/api/agents/nope"), params("nope"));
    expect(response.status).toBe(404);
  });
});

describe("POST /api/tasks", () => {
  it("creates a real task row and journals TASK_CREATED", async () => {
    const response = await postTask(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalId: "TASK-API-1",
          title: "API created task",
          description: "Created through the control API.",
        }),
      }),
    );

    expect(response.status).toBe(201);
    const body = await readJson<{ ok: boolean; data: { externalId: string; status: string } }>(response);
    expect(body.data.externalId).toBe("TASK-API-1");
    expect(body.data.status).toBe("PENDING");

    // It really landed in the database.
    const stored = await testDb.tasks.findByExternalId("TASK-API-1");
    expect(stored).toBeDefined();
  });

  it("rejects a missing title with a validation error", async () => {
    const response = await postTask(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "no title" }),
      }),
    );
    expect(response.status).toBe(422);
  });

  it("rejects a duplicate external id", async () => {
    await postTask(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalId: "TASK-DUP", title: "first", description: "first" }),
      }),
    );
    const second = await postTask(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalId: "TASK-DUP", title: "second", description: "second" }),
      }),
    );
    expect(second.status).toBe(409);
  });
});

describe("GET /api/tasks", () => {
  it("lists tasks and filters by status", async () => {
    await postTask(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalId: "TASK-LIST-1", title: "listed", description: "listed" }),
      }),
    );

    const all = await readJson<{ data: unknown[] }>(await getTasks(new Request("http://localhost/api/tasks")));
    expect(all.data).toHaveLength(1);

    const none = await readJson<{ data: unknown[] }>(
      await getTasks(new Request("http://localhost/api/tasks?status=DONE")),
    );
    expect(none.data).toHaveLength(0);
  });
});

describe("control actions", () => {
  async function createPending(externalId: string): Promise<void> {
    await postTask(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalId, title: externalId, description: "control action target" }),
      }),
    );
  }

  it("start executes the task through the worker and journals the action", async () => {
    await createPending("TASK-CTRL-1");
    const response = await postAction(
      new Request("http://localhost/api/tasks/TASK-CTRL-1/start", { method: "POST" }),
      actionParams("TASK-CTRL-1", "start"),
    );

    expect(response.status).toBe(200);
    const body = await readJson<{ ok: boolean; data: { ok: boolean; task: { status: string } } }>(response);
    expect(body.data.ok).toBe(true);
    // The worker claimed it, so the task is genuinely in flight.
    expect(body.data.task.status).toBe("CODING");

    const task = await testDb.tasks.findByExternalId("TASK-CTRL-1");
    expect(task?.status).toBe("CODING");
    // Real execution, not a UI-only flip: the worker was actually invoked.
    expect(worker.calls.filter((call) => call.kind === "start").map((call) => call.taskId)).toEqual([
      "TASK-CTRL-1",
    ]);

    // Both the task event and the human audit entry are recorded.
    const logs = await testDb.activityLogs.listForTask(task!.id);
    const types = logs.map((log) => log.eventType);
    expect(types).toContain("TASK_STARTED");
    expect(types).toContain("HUMAN_STARTED_TASK");
  });

  it("REJECTS a double start with 409 (idempotency/concurrency guard)", async () => {
    await createPending("TASK-DOUBLE-1");

    // First start wins.
    const first = await postAction(
      new Request("http://localhost/api/tasks/TASK-DOUBLE-1/start", { method: "POST" }),
      actionParams("TASK-DOUBLE-1", "start"),
    );
    expect(first.status).toBe(200);

    // Second start must conflict, not race.
    const second = await postAction(
      new Request("http://localhost/api/tasks/TASK-DOUBLE-1/start", { method: "POST" }),
      actionParams("TASK-DOUBLE-1", "start"),
    );
    expect(second.status).toBe(409);
    const body = await readJson<{ ok: boolean; error: { code: string } }>(second);
    expect(body.ok).toBe(false);

    // Exactly one run could have been created. The second attempt is refused by
    // the control table before it ever reaches a worker (status is CODING, and
    // `start` is only legal from PENDING), so the worker sees a single start.
    const task = await testDb.tasks.findByExternalId("TASK-DOUBLE-1");
    const starts = worker.calls.filter((call) => call.kind === "start");
    expect(starts).toHaveLength(1);
    expect(await testDb.runs.listForTask(task!.id)).toHaveLength(0); // the scripted worker creates no run row
  });

  it("two CONCURRENT starts produce exactly one success", async () => {
    await createPending("TASK-RACE-1");

    const results = await Promise.all([
      postAction(
        new Request("http://localhost/api/tasks/TASK-RACE-1/start", { method: "POST" }),
        actionParams("TASK-RACE-1", "start"),
      ),
      postAction(
        new Request("http://localhost/api/tasks/TASK-RACE-1/start", { method: "POST" }),
        actionParams("TASK-RACE-1", "start"),
      ),
    ]);

    const codes = results.map((response) => response.status).sort();
    expect(codes).toEqual([200, 409]);
  });

  it("pause requests a cooperative stop and records a human audit entry", async () => {
    await createPending("TASK-CTRL-2");
    await postAction(
      new Request("http://localhost/api/tasks/TASK-CTRL-2/start", { method: "POST" }),
      actionParams("TASK-CTRL-2", "start"),
    );

    const response = await postAction(
      new Request("http://localhost/api/tasks/TASK-CTRL-2/pause", {
        method: "POST",
        body: JSON.stringify({ reason: "investigating" }),
      }),
      actionParams("TASK-CTRL-2", "pause"),
    );

    expect(response.status).toBe(200);
    const body = await readJson<{ data: { ok: boolean; pending?: boolean; message: string } }>(response);
    expect(body.data.ok).toBe(true);
    // Cooperative: the API reports "requested", not "already paused".
    expect(body.data.pending).toBe(true);
    expect(body.data.message).toMatch(/safe point/i);

    const task = await testDb.tasks.findByExternalId("TASK-CTRL-2");
    const logs = await testDb.activityLogs.listForTask(task!.id);
    expect(logs.map((log) => log.eventType)).toContain("HUMAN_PAUSED_TASK");
    // The worker was asked, not bypassed.
    expect(worker.calls.some((call) => call.kind === "pause")).toBe(true);
  });

  it("refuses to pause when no worker owns the run (never claims PAUSED)", async () => {
    await createPending("TASK-CTRL-NOWORKER");
    await postAction(
      new Request("http://localhost/api/tasks/TASK-CTRL-NOWORKER/start", { method: "POST" }),
      actionParams("TASK-CTRL-NOWORKER", "start"),
    );

    // Simulate the run belonging to a process that cannot be reached.
    worker.failInterrupts = true;

    const response = await postAction(
      new Request("http://localhost/api/tasks/TASK-CTRL-NOWORKER/pause", { method: "POST" }),
      actionParams("TASK-CTRL-NOWORKER", "pause"),
    );
    expect(response.status).toBe(409);

    // Crucially: the task is NOT marked PAUSED while it is still working.
    const task = await testDb.tasks.findByExternalId("TASK-CTRL-NOWORKER");
    expect(task?.status).not.toBe("PAUSED");
    worker.failInterrupts = false;
  });

  it("resume returns the task to the state it was paused in", async () => {
    await createPending("TASK-CTRL-3");
    await postAction(
      new Request("http://localhost/api/tasks/TASK-CTRL-3/start", { method: "POST" }),
      actionParams("TASK-CTRL-3", "start"),
    );

    // Pausing is the worker's job; simulate the state it writes on unwind.
    const task = await testDb.tasks.findByExternalId("TASK-CTRL-3");
    await testDb.tasks.setStatus(task!.id, "PAUSED", { fromStatus: "CODING", transitionSeqBump: true });

    const response = await postAction(
      new Request("http://localhost/api/tasks/TASK-CTRL-3/resume", { method: "POST" }),
      actionParams("TASK-CTRL-3", "resume"),
    );

    const body = await readJson<{ data: { task: { status: string } } }>(response);
    expect(body.data.task.status).toBe("CODING");

    const logs = await testDb.activityLogs.listForTask(task!.id);
    expect(logs.map((log) => log.eventType)).toContain("HUMAN_RESUMED_TASK");
  });

  it("cancel is terminal and records TASK_CANCELLED", async () => {
    await createPending("TASK-CTRL-4");
    const response = await postAction(
      new Request("http://localhost/api/tasks/TASK-CTRL-4/cancel", {
        method: "POST",
        body: JSON.stringify({ reason: "not needed" }),
      }),
      actionParams("TASK-CTRL-4", "cancel"),
    );

    const body = await readJson<{ data: { task: { status: string } } }>(response);
    expect(body.data.task.status).toBe("CANCELLED");

    const stored = await testDb.tasks.findByExternalId("TASK-CTRL-4");
    const logs = await testDb.activityLogs.listForTask(stored!.id);
    expect(logs.map((log) => log.eventType)).toContain("TASK_CANCELLED");
  });

  it("rejects an unknown action", async () => {
    await createPending("TASK-CTRL-5");
    const response = await postAction(
      new Request("http://localhost/api/tasks/TASK-CTRL-5/nonsense", { method: "POST" }),
      actionParams("TASK-CTRL-5", "nonsense"),
    );
    expect(response.status).toBe(404);
  });

  it("404s an action on an unknown task", async () => {
    const response = await postAction(
      new Request("http://localhost/api/tasks/TASK-MISSING/start", { method: "POST" }),
      actionParams("TASK-MISSING", "start"),
    );
    expect(response.status).toBe(404);
  });
});

describe("task detail and sub-resources", () => {
  async function seedDetail(): Promise<string> {
    await postTask(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalId: "TASK-DETAIL-1",
          title: "detail task",
          description: "detail task",
        }),
      }),
    );
    const task = await testDb.tasks.findByExternalId("TASK-DETAIL-1");
    const { coderId } = await seedAgents(testDb);

    const run = await testDb.runs.start({ taskId: task!.id, runId: "run-1", cycle: 1, reason: "INITIAL" });
    await testDb.toolCalls.start({
      taskId: task!.id,
      agentId: coderId,
      toolCallId: "TASK-DETAIL-1:c1:t1-0",
      tool: "list_files",
      arguments: { ROUTER_API_KEY: ROUTER_KEY, path: "." },
      startedAt: "2026-09-12T21:00:01.000Z",
    });
    await testDb.toolCalls.finish({
      toolCallId: "TASK-DETAIL-1:c1:t1-0",
      taskId: task!.id,
      success: true,
      outputSummary: "3 files",
      finishedAt: "2026-09-12T21:00:02.000Z",
      durationMs: 1_000,
    });
    await testDb.fileChanges.record({
      taskId: task!.id,
      agentId: coderId,
      path: "src/index.js",
      changeType: "created",
      summary: "created module",
      occurredAt: "2026-09-12T21:00:03.000Z",
    });
    await testDb.testResults.save({
      taskId: task!.id,
      agentId: coderId,
      cycle: 1,
      testKey: "final",
      command: "npm test",
      exitCode: 0,
      passed: true,
      durationMs: 900,
      startedAt: "2026-09-12T21:00:04.000Z",
    });
    await testDb.reviews.save({
      taskId: task!.id,
      cycle: 1,
      verdict: "APPROVED",
      severity: "NONE",
      summary: "Looks good",
      issues: [],
      requiredFixes: [],
      reviewer: "reviewer-agent",
      createdAt: "2026-09-12T21:00:05.000Z",
    });
    void run;
    return task!.id;
  }

  it("GET /api/tasks/:id returns the full bundle", async () => {
    await seedDetail();
    const body = await readJson<{
      data: {
        task: { externalId: string };
        runs: unknown[];
        reviews: unknown[];
        toolCalls: unknown[];
        files: unknown[];
        tests: Array<{ authoritative: boolean; passed: boolean }>;
      };
    }>(await getTask(new Request("http://localhost/api/tasks/TASK-DETAIL-1"), params("TASK-DETAIL-1")));

    expect(body.data.task.externalId).toBe("TASK-DETAIL-1");
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.toolCalls).toHaveLength(1);
    expect(body.data.files).toHaveLength(1);
    expect(body.data.reviews).toHaveLength(1);

    // Exactly one authoritative test run, and it is the one that passed.
    const authoritative = body.data.tests.filter((test) => test.authoritative);
    expect(authoritative).toHaveLength(1);
    expect(authoritative[0]?.passed).toBe(true);
  });

  it("redacts redacted-shaped tool arguments on the way out", async () => {
    await seedDetail();
    const text = await (
      await getTask(new Request("http://localhost/api/tasks/TASK-DETAIL-1"), params("TASK-DETAIL-1"))
    ).text();

    expect(text).not.toContain(ROUTER_KEY);
    expect(text).toContain("[REDACTED]");
  });

  it("serves each sub-resource slice", async () => {
    await seedDetail();
    for (const resource of ["runs", "reviews", "tool-calls", "files", "tests", "activity"]) {
      const response = await getAction(
        new Request(`http://localhost/api/tasks/TASK-DETAIL-1/${resource}`),
        actionParams("TASK-DETAIL-1", resource),
      );
      expect(response.status, resource).toBe(200);
      const body = await readJson<{ ok: boolean; data: unknown[] }>(response);
      expect(Array.isArray(body.data), resource).toBe(true);
    }
  });

  it("returns reviews in cycle order so cycle 1..3 are all visible", async () => {
    await seedDetail();
    const task = await testDb.tasks.findByExternalId("TASK-DETAIL-1");
    await testDb.reviews.save({
      taskId: task!.id,
      cycle: 2,
      verdict: "REJECTED",
      severity: "HIGH",
      summary: "Needs work",
      issues: ["missing edge case"],
      requiredFixes: ["handle empty input"],
      reviewer: "reviewer-agent",
      createdAt: "2026-09-12T21:00:06.000Z",
    });

    const reviews = await readJson<{ data: Array<{ cycle: number; verdict: string }> }>(
      await getAction(new Request("http://localhost/api/tasks/TASK-DETAIL-1/reviews"), actionParams("TASK-DETAIL-1", "reviews")),
    );
    expect(reviews.data.map((review) => review.cycle)).toEqual([1, 2]);
    expect(reviews.data.map((review) => review.verdict)).toEqual(["APPROVED", "REJECTED"]);
  });
});

describe("activity ordering", () => {
  it("returns activity oldest-first, ordered by publish sequence", async () => {
    await postTask(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalId: "TASK-ACT-1", title: "activity", description: "activity" }),
      }),
    );
    const task = await testDb.tasks.findByExternalId("TASK-ACT-1");

    // Written out of timestamp order on purpose: publish_seq is the authority.
    await testDb.activityLogs.append({
      eventId: "evt-3",
      taskId: task!.id,
      eventType: "TOOL_STARTED",
      occurredAt: "2026-09-12T21:00:03.000Z",
      payload: { tool: "third" },
    });
    await testDb.activityLogs.append({
      eventId: "evt-1",
      taskId: task!.id,
      eventType: "TOOL_STARTED",
      occurredAt: "2026-09-12T21:00:01.000Z",
      payload: { tool: "first" },
    });
    await testDb.activityLogs.append({
      eventId: "evt-2",
      taskId: task!.id,
      eventType: "TOOL_STARTED",
      occurredAt: "2026-09-12T21:00:02.000Z",
      payload: { tool: "second" },
    });

    const body = await readJson<{ data: Array<{ eventId: string; payload: { tool?: string } }> }>(
      await getTaskActivity(
        new Request("http://localhost/api/tasks/TASK-ACT-1/activity?limit=10"),
        params("TASK-ACT-1"),
      ),
    );

    // Insertion order (publish_seq), exactly as the dashboard timeline expects.
    const custom = body.data
      .map((entry) => entry.eventId)
      .filter((eventId) => eventId.startsWith("evt-"));
    expect(custom).toEqual(["evt-3", "evt-1", "evt-2"]);
  });

  it("serves the global activity feed oldest-first", async () => {
    await postTask(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalId: "TASK-ACT-3", title: "global", description: "global" }),
      }),
    );
    const task = await testDb.tasks.findByExternalId("TASK-ACT-3");
    await testDb.activityLogs.append({
      eventId: "evt-global-1",
      taskId: task!.id,
      eventType: "TASK_STARTED",
      occurredAt: "2026-09-12T21:00:01.000Z",
      payload: {},
    });

    const body = await readJson<{ ok: boolean; data: Array<{ eventId: string }> }>(
      await getActivity(new Request("http://localhost/api/activity?limit=10")),
    );
    expect(body.ok).toBe(true);
    expect(body.data.map((entry) => entry.eventId)).toContain("evt-global-1");
  });

  it("is idempotent on a repeated event id", async () => {
    await postTask(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalId: "TASK-ACT-2", title: "dedupe", description: "dedupe" }),
      }),
    );
    const task = await testDb.tasks.findByExternalId("TASK-ACT-2");

    const first = await testDb.activityLogs.append({ eventId: "evt-dup", taskId: task!.id, eventType: "TOOL_STARTED" });
    const second = await testDb.activityLogs.append({ eventId: "evt-dup", taskId: task!.id, eventType: "TOOL_STARTED" });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

describe("GET /api/reviews", () => {
  it("lists reviews across tasks", async () => {
    const body = await readJson<{ ok: boolean; data: unknown[] }>(await getReviews(new Request("http://localhost/api/reviews")));
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe("GET /api/status", () => {
  it("reports database readiness, counters and realtime state", async () => {
    const body = await readJson<{
      data: {
        database: { configured: boolean; ready: boolean };
        router: { coderModel: string; reviewerModel: string };
        counts: { agents: number };
        realtime: { connections: number; stream: string; transports: string[]; source: string };
        agents: Array<{ displayName: string; role: string }>;
      };
    }>(await getStatus());

    expect(body.data.database.configured).toBe(true);
    expect(body.data.database.ready).toBe(true);
    expect(body.data.counts.agents).toBe(2);
    expect(body.data.realtime.stream).toBe("/api/events");
    // The stream is journal-backed, which is what makes it work across processes.
    expect(body.data.realtime.source).toBe("database");
    // A working fan-out must be discoverable, not reported as an empty list.
    expect(body.data.realtime.transports.length).toBeGreaterThan(0);

    // The two cards the dashboard must show, from real agent rows.
    const coder = body.data.agents.find((agent) => agent.role === "coder");
    const reviewer = body.data.agents.find((agent) => agent.role === "reviewer");
    expect(coder?.displayName).toBe("DEEPSEEK");
    expect(reviewer?.displayName).toBe("GPT");
  });
});

describe("unconfigured database", () => {
  it("answers 503 with a clear reason instead of inventing data", async () => {
    await installRuntime({ configured: false, persistence: undefined, error: "no database" });
    const response = await getAgents();
    expect(response.status).toBe(503);
    const body = await readJson<{ ok: boolean; error: { code: string } }>(response);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("database_not_configured");
  });
});
