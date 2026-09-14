/**
 * End-to-end: orchestrator + persistence + event bus.
 *
 * A real OrchestratorService drives the real state machine and the real review
 * loop. Only the two agents are scripted (they ARE the model boundary) and the
 * workspace is a temp directory. Everything downstream of them — transitions,
 * events, the recorder, the repositories — is the production implementation,
 * backed by a real PostgreSQL (PGlite).
 *
 * This test proves the acceptance criterion: after a task runs, the database
 * holds task → runs → activities → tool calls → file changes → tests → reviews,
 * and the events were publishable through an EventTransport.
 */

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, resetTestDb, type TestDb } from "./helpers/test-db.js";
import {
  CODER_AGENT_KEY,
  REVIEWER_AGENT_KEY,
  OrchestratorService,
} from "../../src/orchestration/runner.js";
import { createPersistenceHooks } from "../../src/orchestration/persistence-hooks.js";
import { createPersistence, type Persistence } from "../../src/persistence/container.js";
import { InMemoryEventTransport } from "../../src/events/transports.js";
import { createLogger } from "../../src/domain/logger.js";
import { summarizeRun } from "../../src/orchestration/report.js";
import type { Agent, AgentInput, AgentOutput, TaskRecord, TaskSpec } from "../../src/domain/types.js";
import type { AgentObserver } from "../../src/agents/agent-observer.js";
import type { AgentRole, AnyTaskEvent } from "../../src/events/types.js";
import { makeCoderOutput, makeReviewerOutput, testConfig } from "../helpers/index.js";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "supabase",
  "migrations",
);

const logger = createLogger({ level: "error", sink: () => {} });

let testDb: TestDb;
let workspaceRoot: string;

beforeAll(async () => {
  testDb = await createTestDb();
  workspaceRoot = await mkdtemp(join(tmpdir(), "ai-team-e2e-"));
}, 60_000);

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await resetTestDb(testDb);
});

/**
 * A scripted agent that ALSO emits observer callbacks, so the event pipeline is
 * driven exactly the way the real agents drive it.
 */
class ObservedScriptedAgent implements Agent {
  readonly calls: AgentInput[] = [];

  constructor(
    readonly id: string,
    readonly role: AgentRole,
    private readonly outputs: AgentOutput[],
    private readonly observer: AgentObserver,
    private readonly emitTools: boolean,
  ) {}

  async execute(input: AgentInput): Promise<AgentOutput> {
    this.calls.push(input);
    const output = this.outputs[this.calls.length - 1] ?? this.outputs[this.outputs.length - 1]!;

    const base = {
      agentId: this.id,
      role: this.role,
      taskId: input.task.id,
      cycle: input.cycle,
    };

    await this.observer.onAgentStarted({
      ...base,
      model: "scripted-model",
      attempt: 1,
      runReason: input.reason,
    });

    if (this.emitTools) {
      const writeId = `${input.task.id}:c${input.cycle}:t1-0`;
      await this.observer.onToolStarted({
        ...base,
        toolCallId: writeId,
        tool: "write_file",
        arguments: { path: "src/index.js", content: "export const x = 1;" },
      });
      await this.observer.onToolFinished({
        ...base,
        toolCallId: writeId,
        tool: "write_file",
        success: true,
        durationMs: 3,
        outputSummary: "created: src/index.js (19B)",
      });
      await this.observer.onFileChanged({
        ...base,
        path: "src/index.js",
        changeType: "created",
        summary: "created",
      });

      const runId = `${input.task.id}:c${input.cycle}:t2-0`;
      await this.observer.onToolStarted({
        ...base,
        toolCallId: runId,
        tool: "run_command",
        arguments: { command: "npm test" },
      });
      await this.observer.onToolFinished({
        ...base,
        toolCallId: runId,
        tool: "run_command",
        success: true,
        durationMs: 40,
        exitCode: 0,
        outputSummary: "$ npm test\nexit_code: 0\n# pass 3",
      });
      await this.observer.onTestFinished({
        ...base,
        command: "npm test",
        exitCode: 0,
        passed: true,
        timedOut: false,
        durationMs: 40,
        outputSummary: "# pass 3",
        authoritative: true,
      });
    }

    await this.observer.onAgentFinished({
      ...base,
      ok: true,
      durationMs: 50,
      promptTokens: 100,
      completionTokens: 20,
    });

    return output;
  }
}

interface E2EResult {
  record: TaskRecord;
  events: AnyTaskEvent[];
  transport: InMemoryEventTransport;
  persistence: Persistence;
}

/** The provider is never called: the agents are scripted. */
const unusedProvider = {
  id: "unused",
  baseUrl: "http://unused.invalid/v1",
  chat: async (): Promise<never> => {
    throw new Error("the provider must not be called: agents are scripted");
  },
  // eslint-disable-next-line require-yield
  chatStream: async function* (): AsyncGenerator<never, never, void> {
    throw new Error("unused");
  },
  listModels: async () => [],
  health: async () => ({ ok: false, baseUrl: "http://unused.invalid/v1", latencyMs: 0 }),
};

async function runE2E(options: {
  coderOutputs: AgentOutput[];
  reviewerOutputs: AgentOutput[];
  maxReviewCycles?: number;
  emitTools?: boolean;
  taskId?: string;
  completionBlocker?: () => string | undefined;
}): Promise<E2EResult> {
  const transport = new InMemoryEventTransport();
  const config = testConfig({
    workspaceRoot,
    maxReviewCycles: options.maxReviewCycles ?? 3,
    databaseUrl: "postgres://shared",
    migrationsDir: MIGRATIONS_DIR,
  });

  // Reuse the test's database handle: the product writes and the assertions read
  // the SAME PostgreSQL instance.
  const persistence = (await createPersistence({
    config,
    logger,
    db: testDb.db,
    transports: [transport],
  }))!;

  const events: AnyTaskEvent[] = [];
  persistence.bus.subscribe((event) => {
    events.push(event as AnyTaskEvent);
  });

  const taskId = options.taskId ?? "TASK-E2E-001";
  const spec: TaskSpec = {
    id: taskId,
    title: "E2E task",
    description: "Exercise the full pipeline with persistence enabled.",
    acceptanceCriteria: ["tests pass"],
  };

  const hooks = createPersistenceHooks({
    bus: persistence.bus,
    recorder: persistence.recorder,
    repositories: persistence.repositories,
    logger,
    runKey: `run-${taskId}`,
    provider: "9router",
    models: { coder: "scripted-coder", reviewer: "scripted-reviewer" },
  });

  const orchestrator = new OrchestratorService({
    provider: unusedProvider,
    config,
    logger,
    createCoder: (_workspace, observer) =>
      new ObservedScriptedAgent(
        CODER_AGENT_KEY,
        "coder",
        options.coderOutputs,
        observer,
        options.emitTools ?? true,
      ),
    createReviewer: (_workspace, observer) =>
      new ObservedScriptedAgent(
        REVIEWER_AGENT_KEY,
        "reviewer",
        options.reviewerOutputs,
        observer,
        false,
      ),
    workspaceResolver: {
      resolve: async (task) => {
        const dir = join(workspaceRoot, task.workspaceSlug ?? task.id);
        await mkdir(dir, { recursive: true });
        return dir;
      },
      cleanup: async () => {}
    },
    hooksFactory: () => hooks,
    resolveAgentIds: async () => persistence.agentIds,
    ...(options.completionBlocker ? { completionBlocker: options.completionBlocker } : {}),
  });

  const record = await orchestrator.run(spec);
  return { record, events, transport, persistence };
}

describe("E2E: TASK -> CODER -> TESTING -> REVIEW -> APPROVED -> DONE (persisted)", () => {
  it("persists the whole chain and publishes the full event sequence", async () => {
    const { record, events, transport, persistence } = await runE2E({
      coderOutputs: [makeCoderOutput()],
      reviewerOutputs: [makeReviewerOutput({ verdict: "APPROVED", severity: "NONE" })],
    });

    // ---- orchestration behaves exactly as before ----
    expect(record.state).toBe("DONE");
    expect(record.approved).toBe(true);
    expect(record.history).toEqual([
      "PENDING",
      "CODING",
      "TESTING",
      "REVIEW",
      "APPROVED",
      "DONE",
    ]);

    // ---- task ----
    const task = await persistence.repositories.tasks.findByExternalId("TASK-E2E-001");
    expect(task).toBeDefined();
    expect(task!.status).toBe("DONE");
    expect(task!.approved).toBe(true);
    expect(task!.currentCycle).toBe(1);
    expect(task!.maxReviewCycles).toBe(3);
    expect(task!.completedAt).toBeTruthy();
    expect(task!.stopReason).toBeUndefined();

    // ---- runs ----
    const runs = await persistence.repositories.runs.listForTask(task!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("COMPLETED");
    expect(runs[0]!.totalTokens).toBeGreaterThan(0);

    // ---- activities ----
    const activities = await persistence.repositories.activityLogs.listForTask(task!.id);
    const types = activities.map((activity) => activity.eventType);
    for (const expected of [
      "TASK_CREATED",
      "TASK_STARTED",
      "STATE_CHANGED",
      "AGENT_STARTED",
      "AGENT_FINISHED",
      "TOOL_STARTED",
      "TOOL_FINISHED",
      "FILE_CHANGED",
      "TEST_FINISHED",
      "SUBMITTED_FOR_REVIEW",
      "REVIEW_FINISHED",
      "TASK_APPROVED",
      "TASK_COMPLETED",
    ]) {
      expect(types, `missing activity ${expected}`).toContain(expected);
    }

    // Each state change is journalled exactly once, in order.
    const stateChanges = activities
      .filter((activity) => activity.eventType === "STATE_CHANGED")
      .map((activity) => (activity.payload as { to: string }).to);
    expect(stateChanges).toEqual(["CODING", "TESTING", "REVIEW", "APPROVED", "DONE"]);

    // ---- tool calls ----
    const toolCalls = await persistence.repositories.toolCalls.listForTask(task!.id);
    expect(toolCalls.length).toBeGreaterThanOrEqual(2);
    const runCommand = toolCalls.find((call) => call.tool === "run_command");
    expect(runCommand?.exitCode).toBe(0);
    expect(runCommand?.success).toBe(true);

    // ---- file changes ----
    const fileChanges = await persistence.repositories.fileChanges.listForTask(task!.id);
    expect(fileChanges.map((change) => change.path)).toContain("src/index.js");
    expect(fileChanges[0]!.changeType).toBe("created");

    // ---- test results ----
    const authoritative = await persistence.repositories.testResults.authoritative(task!.id);
    expect(authoritative?.command).toBe("npm test");
    expect(authoritative?.passed).toBe(true);

    // ---- reviews ----
    const reviews = await persistence.repositories.reviews.listForTask(task!.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.cycle).toBe(1);
    expect(reviews[0]!.verdict).toBe("APPROVED");
    expect(reviews[0]!.severity).toBe("NONE");

    // ---- agents released ----
    for (const agentId of [persistence.agentIds.coder, persistence.agentIds.reviewer]) {
      const agent = await persistence.repositories.agents.findById(agentId!);
      expect(agent?.status).toBe("IDLE");
      expect(agent?.currentTaskId).toBeUndefined();
    }

    // ---- events reached a transport ----
    expect(transport.count()).toBeGreaterThan(0);
    const publishedTypes = transport.all().map((event) => event.type);
    expect(publishedTypes).toContain("TASK_COMPLETED");
    expect(events.length).toBeGreaterThanOrEqual(activities.length);

    // ---- the report agrees with the database ----
    const summary = summarizeRun(record, 3);
    expect(summary.finalState).toBe("DONE");
    expect(summary.reviews).toHaveLength(1);

    await persistence.close();
  }, 60_000);
});

describe("E2E: the rejection loop persists every cycle", () => {
  it("stores both reviews without overwriting the first", async () => {
    const { record, persistence } = await runE2E({
      coderOutputs: [makeCoderOutput(), makeCoderOutput({ summary: "fixed" })],
      reviewerOutputs: [
        makeReviewerOutput({
          verdict: "REJECTED",
          severity: "HIGH",
          issues: ["missing edge case"],
          required_fixes: ["handle empty input"],
        }),
        makeReviewerOutput({ verdict: "APPROVED", severity: "NONE" }),
      ],
    });

    expect(record.state).toBe("DONE");
    expect(record.reviewCycles).toBe(2);

    const task = await persistence.repositories.tasks.findByExternalId("TASK-E2E-001");
    const reviews = await persistence.repositories.reviews.listForTask(task!.id);

    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.cycle).toBe(1);
    expect(reviews[0]!.verdict).toBe("REJECTED");
    expect(reviews[0]!.severity).toBe("HIGH");
    expect(reviews[0]!.requiredFixes).toEqual(["handle empty input"]);
    expect(reviews[0]!.issues).toEqual(["missing edge case"]);
    expect(reviews[1]!.cycle).toBe(2);
    expect(reviews[1]!.verdict).toBe("APPROVED");

    const activities = await persistence.repositories.activityLogs.listForTask(task!.id);
    const types = activities.map((activity) => activity.eventType);
    expect(types).toContain("REVIEW_REJECTED");
    expect(types).toContain("FIX_STARTED");

    const stateChanges = activities
      .filter((activity) => activity.eventType === "STATE_CHANGED")
      .map((activity) => (activity.payload as { to: string }).to);

    expect(stateChanges).toEqual([
      "CODING",
      "TESTING",
      "REVIEW",
      "REJECTED",
      "FIXING",
      "TESTING",
      "REVIEW",
      "APPROVED",
      "DONE",
    ]);

    await persistence.close();
  }, 60_000);
});

describe("E2E: budget exhaustion", () => {
  it("records NEEDS_HUMAN with a stop reason and keeps every review", async () => {
    const { record, persistence } = await runE2E({
      coderOutputs: [makeCoderOutput()],
      reviewerOutputs: [makeReviewerOutput({ verdict: "REJECTED", severity: "MEDIUM" })],
      maxReviewCycles: 2,
    });

    expect(record.state).toBe("NEEDS_HUMAN");
    expect(record.stopReason).toBe("MAX_REVIEW_CYCLES");

    const task = await persistence.repositories.tasks.findByExternalId("TASK-E2E-001");
    expect(task!.status).toBe("NEEDS_HUMAN");
    expect(task!.stopReason).toBe("MAX_REVIEW_CYCLES");
    expect(task!.approved).toBe(false);
    expect(task!.completedAt).toBeFalsy();

    const activities = await persistence.repositories.activityLogs.listForTask(task!.id);
    expect(activities.map((a) => a.eventType)).toContain("TASK_FAILED");

    const runs = await persistence.repositories.runs.listForTask(task!.id);
    expect(runs[0]!.status).toBe("FAILED");

    const reviews = await persistence.repositories.reviews.listForTask(task!.id);
    expect(reviews).toHaveLength(2);
    expect(reviews.map((r) => r.cycle)).toEqual([1, 2]);

    await persistence.close();
  }, 60_000);
});

describe("E2E: recovery", () => {
  it("surfaces a run left RUNNING so it can be marked interrupted", async () => {
    const { persistence } = await runE2E({
      coderOutputs: [makeCoderOutput()],
      reviewerOutputs: [makeReviewerOutput({ verdict: "APPROVED" })],
    });

    const task = await persistence.repositories.tasks.findByExternalId("TASK-E2E-001");

    // Simulate a crashed worker: a run row still marked RUNNING.
    await persistence.repositories.runs.start({
      taskId: task!.id,
      runId: "run-crashed",
      reason: "interrupted worker",
    });

    const stale = await persistence.repositories.runs.listStale(0);
    expect(stale.map((run) => run.runId)).toContain("run-crashed");

    await persistence.close();
  }, 60_000);

  it("refuses DONE when persistence reports a fatal failure", async () => {
    const { record, persistence } = await runE2E({
      coderOutputs: [makeCoderOutput()],
      reviewerOutputs: [makeReviewerOutput({ verdict: "APPROVED" })],
      completionBlocker: () => "activity journal write failed",
    });

    // Approved by the reviewer, but the task must NOT be marked complete.
    expect(record.state).toBe("NEEDS_HUMAN");
    expect(record.approved).toBe(false);
    expect(record.notes.join(" ")).toMatch(/persistence unhealthy/i);

    const task = await persistence.repositories.tasks.findByExternalId("TASK-E2E-001");
    expect(task!.status).toBe("NEEDS_HUMAN");
    expect(task!.approved).toBe(false);
    // The review is still on record: the verdict happened.
    const reviews = await persistence.repositories.reviews.listForTask(task!.id);
    expect(reviews[0]!.verdict).toBe("APPROVED");

    await persistence.close();
  }, 60_000);

  it("handles an agent infrastructure failure without corrupting state", async () => {
    const { record, persistence } = await runE2E({
      coderOutputs: [
        makeCoderOutput({ ok: false, contractParsed: false, error: "9Router request timed out" }),
      ],
      reviewerOutputs: [makeReviewerOutput({ verdict: "APPROVED" })],
      emitTools: false,
    });

    expect(record.state).toBe("NEEDS_HUMAN");
    expect(record.stopReason).toBe("CODER_UNAVAILABLE");

    const task = await persistence.repositories.tasks.findByExternalId("TASK-E2E-001");
    expect(task!.status).toBe("NEEDS_HUMAN");

    const activities = await persistence.repositories.activityLogs.listForTask(task!.id);
    expect(activities.map((a) => a.eventType)).toContain("TASK_FAILED");

    // No reviews: the work never reached the reviewer.
    expect(await persistence.repositories.reviews.listForTask(task!.id)).toHaveLength(0);

    await persistence.close();
  }, 60_000);
});

describe("E2E: idempotency of the persisted stream", () => {
  it("produces exactly one STATE_CHANGED row per transition even though both the repository and the recorder write it", async () => {
    const { persistence } = await runE2E({
      coderOutputs: [makeCoderOutput()],
      reviewerOutputs: [makeReviewerOutput({ verdict: "APPROVED" })],
    });

    const task = await persistence.repositories.tasks.findByExternalId("TASK-E2E-001");
    const activities = await persistence.repositories.activityLogs.listForTask(task!.id);
    const stateChanges = activities.filter((a) => a.eventType === "STATE_CHANGED");

    // The five transitions walked, each written once — no duplicates from the
    // double write path (transition transaction + recorder journal).
    expect(stateChanges).toHaveLength(5);
    expect(task!.transitionSeq).toBe(5);

    const eventIds = new Set(stateChanges.map((a) => a.eventId));
    expect(eventIds.size).toBe(stateChanges.length);

    await persistence.close();
  }, 60_000);
});
