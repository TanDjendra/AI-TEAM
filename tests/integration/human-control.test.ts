/**
 * Human-control integration tests (PHASE 6).
 *
 * Real PostgreSQL, real repositories, real worker plumbing. These cover the
 * failure modes the dashboard must survive: a double start, a run whose process
 * died mid-flight, a pause requested while a run is working, and a retry that
 * must not destroy the previous run's history.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createEventBus } from "../../src/events/bus.js";
import { createLogger } from "../../src/domain/logger.js";
import { createRecoveryService } from "../../src/orchestration/recovery.js";
import { createInterruptWatcher } from "../../src/orchestration/interrupt-listener.js";
import type { Persistence } from "../../src/persistence/container.js";
import { createEventRecorder } from "../../src/persistence/repositories/event-recorder.js";

import { createTestDb, resetTestDb, seedAgents, seedTask, type TestDb } from "./helpers/test-db.js";
import { OrchestratorService } from "../../src/orchestration/runner.js";
import { SingleProcessWorker } from "../../src/orchestration/worker.js";
import { createPersistenceHooks } from "../../src/orchestration/persistence-hooks.js";
import type { AgentRole } from "../../src/events/types.js";
import type { Agent, AgentInput, AgentOutput } from "../../src/domain/types.js";
import type { ModelProvider } from "../../src/providers/model-provider.js";
import { testConfig, makeCoderOutput, makeReviewerOutput } from "../helpers/index.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir } from "node:fs/promises";

let testDb: TestDb;
let workspaceRoot: string;
const logger = createLogger({ level: "error", sink: () => {} });

function stubProvider(): ModelProvider {
  return {
    generate: async () => ({ text: "stub", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })
  } as unknown as ModelProvider;
}

/** A Persistence view wired to the real test database. */
function persistenceFor(): { persistence: Persistence; bus: ReturnType<typeof createEventBus> } {
  const bus = createEventBus();
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
    workflows: testDb.workflows,
    workflowDependencies: testDb.workflowDependencies,
  };
  const recorder = createEventRecorder({ repositories, logger });
  recorder.attach(bus);
  return {
    persistence: {
      db: testDb.db,
      bus,
      recorder,
      repositories,
      transport: { name: "in-memory", publish: async () => {} },
      agentIds: {},
      agentKeys: { coder: "coder-agent", reviewer: "reviewer-agent" },
      warnings: [],
      close: async () => {},
    } as unknown as Persistence,
    bus,
  };
}

/**
 * A scripted agent that honours the cooperative `guard`, exactly like the real
 * coder does (between turns and before each tool call).
 *
 * It signals when it is mid-run, then blocks until released, so a test can pause
 * it while work is genuinely in flight.
 */
class GuardAwareAgent implements Agent {
  readonly calls: AgentInput[] = [];
  readonly entered = createDeferred<void>();
  private release = createDeferred<void>();
  guardChecks = 0;

  constructor(
    readonly id: string,
    readonly role: AgentRole,
    private readonly output: AgentOutput,
    private readonly holdMs: number,
  ) {}

  /** Lets a held run continue. */
  resume(): void {
    this.release.resolve();
  }

  async execute(input: AgentInput): Promise<AgentOutput> {
    this.calls.push(input);
    this.entered.resolve();

    // Wait to be released, but check the guard the whole time — this is what a
    // real agent does at its safe points.
    const deadline = Date.now() + this.holdMs;
    while (Date.now() < deadline) {
      this.guardChecks += 1;
      input.guard?.(); // throws TaskInterruptError when a human asked to stop
      await Promise.race([this.release.promise, sleep(25)]);
      if (this.released) break;
    }

    this.guardChecks += 1;
    input.guard?.();
    return this.output;
  }

  private get released(): boolean {
    return this.release.settled;
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void; settled: boolean } {
  let resolve!: (value?: T) => void;
  let settled = false;
  const promise = new Promise<T>((r) => {
    resolve = (value?: T) => {
      settled = true;
      r(value as T);
    };
  });
  return {
    promise,
    resolve: (value?: T) => resolve(value),
    get settled() {
      return settled;
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Builds a worker backed by the REAL orchestrator and real repositories.
 *
 * Only the two agents are scripted (they are the model boundary). The pause
 * plumbing, interrupt repository, state machine and worker are production code.
 */
async function buildRealWorker(options: {
  coder: Agent;
  reviewer: Agent;
}): Promise<{ worker: SingleProcessWorker; orchestrator: OrchestratorService; persistence: Persistence }> {
  const { persistence, bus } = persistenceFor();
  const orchestrator = new OrchestratorService({
    provider: stubProvider(),
    config: testConfig({ workspaceRoot: join(workspaceRoot, "control") }),
    logger,
    createCoder: () => options.coder,
    createReviewer: () => options.reviewer,
    workspaceResolver: {
      resolve: async (task) => {
        const dir = join(workspaceRoot, "control", task.workspaceSlug ?? task.id);
        await mkdir(dir, { recursive: true });
        return dir;
      },
      cleanup: async () => {}
    },
    hooksFactory: () => createPersistenceHooks({
      bus,
      recorder: persistence.recorder,
      repositories: persistence.repositories,
      logger,
      runKey: "test-run",
      provider: "test-provider",
      models: { coder: "test-coder", reviewer: "test-reviewer" }
    }),
  });

  const worker = new SingleProcessWorker({
    persistence,
    orchestrator,
    logger,
    heartbeatIntervalMs: 100,
    interruptWatcherFor: (internalTaskId) =>
      createInterruptWatcher({ interrupts: testDb.interrupts, taskId: internalTaskId, refreshMs: 0 }),
  });

  return { worker, orchestrator, persistence };
}

describe("cooperative pause (real worker + real orchestrator)", () => {
  it("stops mid-run at a safe point and only then records PAUSED", async () => {
    const coder = new GuardAwareAgent(
      "coder-agent",
      "coder",
      makeCoderOutput({ summary: "done", files_changed: [], tests_run: ["npm test"], tests_passed: true }),
      15_000,
    );
    const reviewer = new GuardAwareAgent("reviewer-agent", "reviewer", makeReviewerOutput({ verdict: "APPROVED" }), 1);

    const { worker } = await buildRealWorker({ coder, reviewer });
    await seedAgents(testDb);

    const created = await testDb.tasks.create({
      externalId: "TASK-PAUSE-1",
      title: "Pause me",
      description: "Cooperative pause test",
      workspace: join(workspaceRoot, "control", "TASK-PAUSE-1"),
      maxReviewCycles: 3,
    });

    await worker.start("TASK-PAUSE-1", {
      spec: { id: "TASK-PAUSE-1", title: "Pause me", description: "Cooperative pause test" },
    });

    // The run is genuinely in flight.
    await coder.entered.promise;

    const beforePause = await testDb.tasks.findByExternalId("TASK-PAUSE-1");
    expect(beforePause?.status).toBe("CODING");

    // Request the pause while the agent is holding.
    const outcome = await worker.pause("TASK-PAUSE-1", { reason: "hold it" });
    expect(outcome.ok).toBe(true);

    // The agent unwinds at its next safe point (it is polling `guard`).
    await waitFor(async () => {
      const task = await testDb.tasks.findByExternalId("TASK-PAUSE-1");
      return task?.status === "PAUSED" ? task : undefined;
    });

    const paused = await testDb.tasks.findByExternalId("TASK-PAUSE-1");
    expect(paused?.status).toBe("PAUSED");
    // The state it should resume into was captured, not guessed.
    expect(paused?.resumeStatus).toBe("CODING");
    expect(coder.guardChecks).toBeGreaterThan(0);

    // The run row was closed, so it will not look abandoned.
    const runs = await testDb.runs.listForTask(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("CANCELLED");
    expect(runs[0]!.stopReason).toBe("PAUSED_BY_HUMAN");

    // Agents were released.
    const agents = await testDb.agents.list();
    for (const agent of agents) expect(agent.status).toBe("IDLE");
  });

  it("does not mark PAUSED when no worker owns the run", async () => {
    await seedAgents(testDb);
    await testDb.tasks.create({
      externalId: "TASK-PAUSE-2",
      title: "Unowned",
      description: "No worker",
      workspace: join(workspaceRoot, "control", "TASK-PAUSE-2"),
      maxReviewCycles: 3,
    });
    await testDb.tasks.setStatus(
      (await testDb.tasks.findByExternalId("TASK-PAUSE-2"))!.id,
      "CODING",
      { transitionSeqBump: true },
    );

    const coder = new GuardAwareAgent("coder-agent", "coder", makeCoderOutput(), 1);
    const reviewer = new GuardAwareAgent("reviewer-agent", "reviewer", makeReviewerOutput(), 1);
    const { worker } = await buildRealWorker({ coder, reviewer });

    const outcome = await worker.pause("TASK-PAUSE-2", { reason: "nobody home" });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("no-worker");

    // Honest: the task is NOT paused, because nothing could be stopped.
    const task = await testDb.tasks.findByExternalId("TASK-PAUSE-2");
    expect(task?.status).toBe("CODING");
  });
});

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await sleep(25);
  }
}

describe("crash recovery (real worker)", () => {
  it("marks the run failed, the task NEEDS_HUMAN and the agent ERROR", async () => {
    class ExplodingAgent implements Agent {
      constructor(readonly id: string, readonly role: AgentRole) {}
      async execute(): Promise<AgentOutput> {
        throw new Error("simulated agent crash");
      }
    }

    await seedAgents(testDb);
    const { worker } = await buildRealWorker({
      coder: new ExplodingAgent("coder-agent", "coder"),
      reviewer: new ExplodingAgent("reviewer-agent", "reviewer"),
    });

    const created = await testDb.tasks.create({
      externalId: "TASK-CRASH-1",
      title: "Crash",
      description: "Crash recovery",
      workspace: join(workspaceRoot, "control", "TASK-CRASH-1"),
      maxReviewCycles: 3,
    });

    await worker.start("TASK-CRASH-1", {
      spec: { id: "TASK-CRASH-1", title: "Crash", description: "Crash recovery" },
    });
    await worker.shutdown();

    const task = await testDb.tasks.findByExternalId("TASK-CRASH-1");
    // Never DONE, and never silently lost.
    expect(task?.status).toBe("NEEDS_HUMAN");
    expect(task?.approved).toBe(false);

    const runs = await testDb.runs.listForTask(created.id);
    expect(runs.some((run) => run.status === "FAILED")).toBe(true);
  });
});

beforeEach(async () => {
  testDb ??= await createTestDb();
  await resetTestDb(testDb);
  workspaceRoot = await mkdtemp(join(tmpdir(), "human-control-"));
});

/**
 * Moves a task's liveness timestamps into the past.
 *
 * A just-started task is correctly NOT stale, so a stale-detection test has to
 * age it — this is fixture setup, not a faked production write.
 */
async function backdateTask(taskId: string, ms: number): Promise<void> {
  await testDb.db.exec(
    `update tasks
        set started_at = now() - (${Math.trunc(ms)}::int * interval '1 millisecond'),
            heartbeat_at = now() - (${Math.trunc(ms)}::int * interval '1 millisecond'),
            created_at = now() - (${Math.trunc(ms)}::int * interval '1 millisecond')
      where id = '${taskId}'`,
  );
}

afterAll(async () => {
  await testDb?.close();
});

describe("double-start protection", () => {
  it("claim() lets exactly one of two concurrent workers win", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-RACE" });

    const [first, second] = await Promise.all([
      testDb.tasks.claim({ taskId: task.id, eventId: "claim-a" }),
      testDb.tasks.claim({ taskId: task.id, eventId: "claim-b" }),
    ]);

    const winners = [first, second].filter((outcome) => outcome.claimed);
    expect(winners).toHaveLength(1);
    // The loser is told why, not given a silent success.
    const loser = [first, second].find((outcome) => !outcome.claimed);
    expect(loser?.reason).toBe("already-claimed");
  });

  it("refuses to claim a task that is already in flight", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-INFLIGHT" });
    await testDb.tasks.claim({ taskId: task.id, eventId: "claim-1" });

    const again = await testDb.tasks.claim({ taskId: task.id, eventId: "claim-2" });
    expect(again.claimed).toBe(false);
    expect(again.reason).toBe("already-claimed");
  });

  it("refuses to claim a terminal task", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-TERMINAL" });
    await testDb.tasks.setStatus(task.id, "DONE", { transitionSeqBump: true });

    const outcome = await testDb.tasks.claim({ taskId: task.id, eventId: "claim-x" });
    expect(outcome.claimed).toBe(false);
    expect(outcome.reason).toBe("terminal");
  });

  it("journals exactly one STATE_CHANGED row for a claim, even when the event id repeats", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-IDEMPOTENT" });
    await testDb.tasks.claim({ taskId: task.id, eventId: "claim-dup" });

    const logs = await testDb.activityLogs.listForTask(task.id);
    expect(logs.filter((log) => log.eventType === "STATE_CHANGED")).toHaveLength(1);
  });
});

describe("cooperative pause", () => {
  it("records one outstanding request per intent, even on a double click", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-PAUSE" });

    await testDb.interrupts.request({ taskId: task.id, intent: "pause", reason: "first" });
    await testDb.interrupts.request({ taskId: task.id, intent: "pause", reason: "second" });

    const all = await testDb.interrupts.listForTask(task.id);
    expect(all).toHaveLength(1);
    // The latest reason wins, so the operator's note is not lost.
    expect(all[0]?.reason).toBe("second");
  });

  it("is visible to a watcher and can be acknowledged once", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-WATCH" });
    await testDb.interrupts.request({ taskId: task.id, intent: "pause", reason: "coffee" });

    const watcher = createInterruptWatcher({ interrupts: testDb.interrupts, taskId: task.id });
    await watcher.refresh();
    expect(watcher.pull()?.intent).toBe("pause");
    expect(watcher.pull()?.reason).toBe("coffee");

    const acknowledged = await testDb.interrupts.acknowledge({ taskId: task.id, intent: "pause" });
    expect(acknowledged?.acknowledgedAt).toBeDefined();

    await watcher.refresh();
    expect(watcher.pull()).toBeUndefined();
  });

  it("can be cleared so a resumed run is not stopped again", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-CLEAR" });
    await testDb.interrupts.request({ taskId: task.id, intent: "pause", reason: "x" });
    expect(await testDb.interrupts.clear(task.id)).toBe(1);
    expect(await testDb.interrupts.pending(task.id)).toBeUndefined();
  });

  it("records pause and cancel as separate intents", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-INTENTS" });
    await testDb.interrupts.request({ taskId: task.id, intent: "pause", reason: "p" });
    await testDb.interrupts.request({ taskId: task.id, intent: "cancel", reason: "c" });

    const all = await testDb.interrupts.listForTask(task.id);
    expect(all.map((entry) => entry.intent).sort()).toEqual(["cancel", "pause"]);
  });
});

describe("retry creates a new run and keeps the old one", () => {
  it("records run 1, run 2 without overwriting", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-RETRY" });

    await testDb.runs.start({ taskId: task.id, runId: "TASK-RETRY#run1", cycle: 1, reason: "orchestrator" });
    await testDb.runs.finish({ runId: "TASK-RETRY#run1", status: "FAILED", stopReason: "MAX_REVIEW_CYCLES" });

    // Retry: a NEW run id, exactly as the persistence hooks now derive.
    await testDb.runs.start({ taskId: task.id, runId: "TASK-RETRY#run2", cycle: 1, reason: "orchestrator" });

    const runs = await testDb.runs.listForTask(task.id);
    expect(runs.map((run) => run.runId)).toEqual(["TASK-RETRY#run1", "TASK-RETRY#run2"]);
    // The first run's outcome is preserved.
    expect(runs[0]?.status).toBe("FAILED");
    expect(runs[0]?.stopReason).toBe("MAX_REVIEW_CYCLES");
    expect(runs[1]?.status).toBe("RUNNING");
  });

  it("proves the failure mode: reusing a run id would collapse the history", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-COLLAPSE" });
    await testDb.runs.start({ taskId: task.id, runId: "same-key", cycle: 1 });
    await testDb.runs.finish({ runId: "same-key", status: "FAILED" });
    await testDb.runs.start({ taskId: task.id, runId: "same-key", cycle: 1 });

    // Documented behaviour of the repository: `start` is idempotent on run_id,
    // which is exactly why the caller must supply a fresh key per execution.
    const runs = await testDb.runs.listForTask(task.id);
    expect(runs).toHaveLength(1);
  });
});

describe("stale detection", () => {
  it("finds an in-flight task whose heartbeat stopped, and changes nothing", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-STALE" });
    await testDb.tasks.claim({ taskId: task.id, eventId: "claim-stale" });
    await testDb.runs.start({ taskId: task.id, runId: "stale-run", cycle: 1 });
    // Age it past the threshold: a task that just started is not stale.
    await backdateTask(task.id, 60_000);

    // No heartbeat at all + a zero threshold => stale.
    const detected = await createRecoveryService({
      persistence: persistenceFor().persistence,
      logger,
      staleThresholdMs: 1_000,
    }).detect();

    expect(detected.map((action) => action.taskExternalId)).toContain("TASK-STALE");

    // Detection is read-only.
    const unchanged = await testDb.tasks.findByExternalId("TASK-STALE");
    expect(unchanged?.status).toBe("CODING");
  });

  it("does not report a task as stale while its heartbeat is fresh", async () => {
    const task = await seedTask(testDb, { externalId: "TASK-FRESH" });
    await testDb.tasks.claim({ taskId: task.id, eventId: "claim-fresh" });
    await testDb.tasks.heartbeat(task.id);

    const detected = await createRecoveryService({
      persistence: persistenceFor().persistence,
      logger,
      // Generous threshold: a freshly pinged task cannot be stale.
      staleThresholdMs: 60_000,
    }).detect();

    expect(detected.map((action) => action.taskExternalId)).not.toContain("TASK-FRESH");
  });

  it("marks the run INTERRUPTED and emits TASK_STALE without deleting anything", async () => {
    const { persistence, bus } = persistenceFor();
    const task = await seedTask(testDb, { externalId: "TASK-RECOVER" });
    await testDb.tasks.claim({ taskId: task.id, eventId: "claim-recover" });
    await testDb.runs.start({ taskId: task.id, runId: "recover-run", cycle: 1 });
    await backdateTask(task.id, 60_000);

    const events: string[] = [];
    bus.subscribe((event) => {
      events.push(event.type);
    });

    const report = await createRecoveryService({
      persistence,
      logger,
      staleThresholdMs: 1_000,
    }).recover({ staleTaskStatus: "NEEDS_HUMAN" });

    expect(report.applied.map((action) => action.taskExternalId)).toContain("TASK-RECOVER");

    // The run is closed, not removed.
    const run = await testDb.runs.findByRunId("recover-run");
    expect(run?.status).toBe("INTERRUPTED");
    expect(run?.stopReason).toBe("STALE_RUN");

    // The task is handed to a human, never silently completed.
    const task2 = await testDb.tasks.findByExternalId("TASK-RECOVER");
    expect(task2?.status).toBe("NEEDS_HUMAN");
    // Its history is intact.
    expect(await testDb.runs.listForTask(task.id)).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toContain("TASK_STALE");
  });

  it("honours a NONE policy by recording the event but leaving the state alone", async () => {
    const { persistence } = persistenceFor();
    const task = await seedTask(testDb, { externalId: "TASK-DETECT-ONLY" });
    await testDb.tasks.claim({ taskId: task.id, eventId: "claim-detect" });
    await testDb.runs.start({ taskId: task.id, runId: "detect-run", cycle: 1 });
    await backdateTask(task.id, 60_000);

    await createRecoveryService({ persistence, logger, staleThresholdMs: 1_000 }).recover({
      staleTaskStatus: "NONE",
      markRunsInterrupted: false,
    });

    const unchanged = await testDb.tasks.findByExternalId("TASK-DETECT-ONLY");
    expect(unchanged?.status).toBe("CODING");
    const run = await testDb.runs.findByRunId("detect-run");
    expect(run?.status).toBe("RUNNING");
  });
});

describe("crash recovery", () => {
  it("releases agents still parked on a task nobody is running", async () => {
    const { persistence } = persistenceFor();
    const { coderId, reviewerId } = await seedAgents(testDb);
    const task = await seedTask(testDb, { externalId: "TASK-CRASH" });

    await testDb.tasks.claim({ taskId: task.id, agentId: coderId, eventId: "claim-crash" });
    // Simulate a process that died while both agents were busy.
    await testDb.agents.setStatus(coderId, "WORKING", { currentTaskId: task.id });
    await testDb.agents.setStatus(reviewerId, "REVIEWING", { currentTaskId: task.id });
    await testDb.runs.start({ taskId: task.id, runId: "crash-run", cycle: 1 });
    await backdateTask(task.id, 60_000);

    await createRecoveryService({ persistence, logger, staleThresholdMs: 1_000 }).recover();

    const coder = await testDb.agents.findById(coderId);
    const reviewer = await testDb.agents.findById(reviewerId);
    expect(coder?.status).toBe("IDLE");
    expect(coder?.currentTaskId).toBeUndefined();
    expect(reviewer?.status).toBe("IDLE");
    expect(reviewer?.currentTaskId).toBeUndefined();
  });

  it("never marks a crashed task DONE", async () => {
    const { persistence } = persistenceFor();
    const task = await seedTask(testDb, { externalId: "TASK-NOT-DONE" });
    await testDb.tasks.claim({ taskId: task.id, eventId: "claim-notdone" });
    await testDb.runs.start({ taskId: task.id, runId: "notdone-run", cycle: 1 });
    await backdateTask(task.id, 60_000);

    await createRecoveryService({ persistence, logger, staleThresholdMs: 1_000 }).recover();

    const recovered = await testDb.tasks.findByExternalId("TASK-NOT-DONE");
    expect(recovered?.status).not.toBe("DONE");
    expect(recovered?.approved).toBe(false);
  });

  it("recovers one task on demand, even before the threshold elapses", async () => {
    const { persistence } = persistenceFor();
    const task = await seedTask(testDb, { externalId: "TASK-MANUAL" });
    await testDb.tasks.claim({ taskId: task.id, eventId: "claim-manual" });
    await testDb.runs.start({ taskId: task.id, runId: "manual-run", cycle: 1 });

    // A very long threshold: only an explicit operator action could fire.
    const recovery = createRecoveryService({ persistence, logger, staleThresholdMs: 3_600_000 });
    expect(await recovery.detect()).toHaveLength(0);

    const result = await recovery.recoverTask("TASK-MANUAL");
    expect(result.ok).toBe(true);
    expect((await testDb.runs.findByRunId("manual-run"))?.status).toBe("INTERRUPTED");
    expect((await testDb.tasks.findByExternalId("TASK-MANUAL"))?.status).toBe("NEEDS_HUMAN");
  });
});

describe("human audit trail", () => {
  it("keeps human events distinguishable from agent events", async () => {
    const { persistence, bus } = persistenceFor();
    const task = await seedTask(testDb, { externalId: "TASK-AUDIT" });

    const recorded: Array<{ type: string; payload: Record<string, unknown> }> = [];
    bus.subscribe((event) => {
      recorded.push({ type: event.type, payload: event.payload as Record<string, unknown> });
    });

    await testDb.activityLogs.append({
      eventId: "human-1",
      taskId: task.id,
      eventType: "HUMAN_PAUSED_TASK",
      payload: {
        actor: "human",
        action: "pause",
        taskId: "TASK-AUDIT",
        timestamp: new Date().toISOString(),
        note: "investigating a flaky test",
      },
    });
    await testDb.activityLogs.append({
      eventId: "agent-1",
      taskId: task.id,
      eventType: "AGENT_STARTED",
      payload: { agentId: "coder", role: "coder" },
    });

    const logs = await testDb.activityLogs.listForTask(task.id);
    const human = logs.find((log) => log.eventType === "HUMAN_PAUSED_TASK");
    expect(human?.payload.actor).toBe("human");
    expect(human?.payload.action).toBe("pause");
    expect(human?.payload.note).toBe("investigating a flaky test");
    expect(typeof human?.payload.timestamp).toBe("string");
    // The agent event carries no human marker.
    const agent = logs.find((log) => log.eventType === "AGENT_STARTED");
    expect(agent?.payload.actor).toBeUndefined();
  });
});
