/**
 * Dashboard service tests.
 *
 * Uses a lightweight in-memory persistence stub — the service's job is
 * orchestration and view assembly, and the SQL it depends on is covered by the
 * PostgreSQL integration suite. No model is called and no fake "AI" output is
 * invented: every record below is a plain database row shape.
 */

import { describe, expect, it } from "vitest";

import { createDashboardService, displayNameForModel, ServiceError } from "../../src/dashboard/service.js";
import type { WorkerOutcome } from "../../src/orchestration/worker.js";
import { createEventBus } from "../../src/events/bus.js";
import type { AnyTaskEvent } from "../../src/events/types.js";
import type { Persistence } from "../../src/persistence/container.js";
import { createLogger } from "../../src/domain/logger.js";

const silentLogger = createLogger({ level: "error", sink: () => {} });

function taskRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    externalId: "TASK-001",
    title: "Create a string utility module",
    description: "Implement slugify and wordCount with tests.",
    status: "DONE",
    workspace: "D:/ws/TASK-001",
    currentCycle: 1,
    maxReviewCycles: 3,
    approved: true,
    transitionSeq: 5,
    createdAt: "2026-09-12T21:00:00.000Z",
    updatedAt: "2026-09-12T21:05:00.000Z",
    ...overrides,
  };
}

function agentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "5b440289-4f6b-46df-bf20-c77f04e43492",
    agentKey: "coder-agent",
    role: "coder",
    provider: "9router",
    model: "grip/deepseek-v4.1-flash",
    status: "IDLE",
    lastSeen: "2026-09-12T21:05:00.000Z",
    ...overrides,
  };
}

interface StubOverrides {
  tasks?: Record<string, unknown>[];
  agents?: Record<string, unknown>[];
  activity?: Record<string, unknown>[];
  reviews?: Record<string, unknown>[];
  event?: AnyTaskEvent;
}

function createStubPersistence(overrides: StubOverrides = {}): {
  persistence: Persistence;
  bus: ReturnType<typeof createEventBus>;
  published: AnyTaskEvent[];
} {
  const bus = createEventBus({ now: () => new Date("2026-09-12T21:00:00.000Z") });
  const published: AnyTaskEvent[] = [];
  bus.subscribe(async (event) => {
    published.push(event);
  });

  const tasks = overrides.tasks ?? [taskRecord()];
  const agents = overrides.agents ?? [agentRecord()];

  const repositories = {
    tasks: {
      create: async (input: { externalId: string; title: string; description: string; workspace: string; maxReviewCycles: number }) =>
        taskRecord({
          ...input,
          status: "PENDING",
          currentCycle: 0,
          approved: false,
          transitionSeq: 1,
        }),
      findById: async (id: string) => tasks.find((task) => task.id === id),
      findByExternalId: async (externalId: string) => tasks.find((task) => task.externalId === externalId),
      list: async () => tasks,
      countsByStatus: async () => ({ DONE: 1 }),
      statsForAgent: async () => ({ total: 1, done: 1, failed: 0, active: 0 }),
      transition: async () => ({ applied: true, task: taskRecord({ status: "CODING" }) }),
      setStatus: async (_id: string, status: string) => taskRecord({ status }),
      touch: async () => {},
    },
    agents: {
      list: async () => agents,
      findByKey: async (key: string) => agents.find((agent) => agent.agentKey === key),
      findById: async (id: string) => agents.find((agent) => agent.id === id),
    },
    activityLogs: {
      latest: async () => overrides.activity ?? [],
      listForTask: async () => overrides.activity ?? [],
      listForAgent: async () => overrides.activity ?? [],
      countAll: async () => (overrides.activity ?? []).length,
      countForTask: async () => (overrides.activity ?? []).length,
    },
    reviews: {
      listRecent: async () => overrides.reviews ?? [],
      listForTask: async () => overrides.reviews ?? [],
      latestForTask: async () => (overrides.reviews ?? [])[0],
      countAll: async () => (overrides.reviews ?? []).length,
      countsForAgent: async () => ({ total: 1, approved: 1, rejected: 0 }),
      statsForReviewer: async () => ({ total: 0, approved: 0, rejected: 0 }),
    },
    interrupts: {
      request: async () => ({ id: "i1", taskId: "t", intent: "pause", reason: "r", actor: "human", requestedAt: "2026-09-12T21:06:00.000Z" }),
      pending: async () => undefined,
      listForTask: async () => [],
      acknowledge: async () => undefined,
      clear: async () => 0,
    },
    toolCalls: { listForTask: async () => [] },
    fileChanges: { listForTask: async () => [] },
    testResults: { listForTask: async () => [], authoritative: async () => undefined },
    runs: { listForTask: async () => [] },
  };
  const persistence = {
    repositories,
    bus,
  } as unknown as Persistence;

  return { persistence, bus, published };
}

function buildService(overrides: StubOverrides = {}, workerOverride?: Partial<StubWorker>) {
  const stub = createStubPersistence(overrides);
  const worker = createStubWorker(workerOverride);
  const service = createDashboardService({
    persistence: stub.persistence,
    logger: silentLogger,
    router: {
      baseUrl: "http://localhost:20128/v1",
      coderModel: "grip/deepseek-v4.1-flash",
      reviewerModel: "grip/gpt-5.6-luna",
    },
    workspaceRoot: "D:/ws",
    worker,
    now: () => new Date("2026-09-12T21:06:00.000Z"),
    newId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  return { service, worker, ...stub };
}

interface StubWorker {
  start(taskId: string, options: unknown): Promise<WorkerOutcome>;
  pause(taskId: string, options?: unknown): Promise<WorkerOutcome>;
  cancel(taskId: string, options?: unknown): Promise<WorkerOutcome>;
  isBusy(taskId: string): boolean;
  busyTasks(): string[];
  shutdown(): Promise<void>;
  calls: Array<{ kind: "start" | "pause" | "cancel"; taskId: string }>;
}

/**
 * Minimal TaskWorker stand-in.
 *
 * `start` returns ok but does NOT change status: in this unit suite the status
 * change is the worker's job (as it is in production), and the tests assert on
 * what the service does around it.
 */
function createStubWorker(overrides: Partial<StubWorker> = {}): StubWorker {
  const calls: StubWorker["calls"] = [];
  const busy = new Set<string>();
  return {
    calls,
    async start(taskId) {
      calls.push({ kind: "start", taskId });
      busy.add(taskId);
      return { ok: true, message: "started", status: "CODING" };
    },
    async pause(taskId) {
      calls.push({ kind: "pause", taskId });
      return { ok: true, message: "pause requested" };
    },
    async cancel(taskId) {
      calls.push({ kind: "cancel", taskId });
      return { ok: true, message: "cancel requested" };
    },
    isBusy: (taskId) => busy.has(taskId),
    busyTasks: () => [...busy],
    shutdown: async () => {},
    ...overrides,
  } as StubWorker;
}

describe("displayNameForModel", () => {
  it("derives a display name from the real model id", () => {
    expect(displayNameForModel("grip/deepseek-v4.1-flash")).toBe("DEEPSEEK");
    expect(displayNameForModel("grip/gpt-5.6-luna")).toBe("GPT");
    expect(displayNameForModel("local-model")).toBe("LOCAL");
  });
});

describe("getAgent", () => {
  it("resolves an agent by key and reports persisted counts only", async () => {
    const { service } = buildService();
    const detail = await service.getAgent("coder-agent");

    expect(detail?.agent.role).toBe("coder");
    expect(detail?.agent.displayName).toBe("DEEPSEEK");
    expect(detail?.agent.model).toBe("grip/deepseek-v4.1-flash");
    // Counters come from stored rows, never from an estimate.
    expect(detail?.stats.total).toBe(1);
    expect(detail?.stats.done).toBe(1);
  });

  it("returns undefined for an unknown agent", async () => {
    const { service } = buildService();
    expect(await service.getAgent("nope")).toBeUndefined();
  });
});

describe("listTasks", () => {
  it("returns real task rows with no fabricated progress", async () => {
    const { service } = buildService();
    const tasks = await service.listTasks();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.externalId).toBe("TASK-001");
    expect(tasks[0]?.status).toBe("DONE");
    expect(tasks[0]?.title).toBe("Create a string utility module");
    // No percentage-style fields exist on the view model at all.
    expect(Object.keys(tasks[0]!)).not.toContain("progress");
    expect(Object.keys(tasks[0]!)).not.toContain("percent");
  });
});

describe("getTaskDetail", () => {
  it("returns the full detail bundle for one task", async () => {
    const { service } = buildService();
    const detail = await service.getTaskDetail("TASK-001");

    expect(detail?.task.externalId).toBe("TASK-001");
    expect(detail).toHaveProperty("runs");
    expect(detail).toHaveProperty("reviews");
    expect(detail).toHaveProperty("toolCalls");
    expect(detail).toHaveProperty("files");
    expect(detail).toHaveProperty("tests");
    expect(detail).toHaveProperty("activity");
  });

  it("returns undefined for an unknown task", async () => {
    const { service } = buildService();
    expect(await service.getTaskDetail("TASK-999")).toBeUndefined();
  });
});

describe("systemStatus", () => {
  it("reports database readiness and real counters", async () => {
    const { service } = buildService();
    const status = await service.systemStatus();

    expect(status.database.configured).toBe(true);
    expect(status.database.ready).toBe(true);
    expect(status.counts.tasks).toBe(1);
    expect(status.router.coderModel).toBe("grip/deepseek-v4.1-flash");
    // The API key is never part of the status view.
    expect(JSON.stringify(status)).not.toContain("sk-");
  });
});

describe("control actions", () => {
  it("records an event for every action it performs", async () => {
    const { service, published } = buildService({
      tasks: [taskRecord({ status: "PENDING", approved: false })],
    });

    const outcome = await service.startTask("TASK-001");

    expect(outcome.ok).toBe(true);
    expect(outcome.eventId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(published.map((event) => event.type)).toContain("TASK_STARTED");
  });

  it("refuses to start a task that is already done", async () => {
    const { service } = buildService();
    await expect(service.startTask("TASK-001")).rejects.toBeInstanceOf(ServiceError);
  });

  it("refuses to pause a task in a terminal state", async () => {
    const { service } = buildService();
    await expect(service.pauseTask("TASK-001")).rejects.toBeInstanceOf(ServiceError);
  });

  it("publishes a cooperative pause request and audits it", async () => {
    const { service, published, worker } = buildService({
      tasks: [taskRecord({ status: "CODING", approved: false })],
    });

    const outcome = await service.pauseTask("TASK-001", "investigating");

    // Cooperative: the service reports the request, and the worker was asked.
    expect(outcome.ok).toBe(true);
    expect(outcome.pending).toBe(true);
    expect(worker.calls.some((call) => call.kind === "pause")).toBe(true);
    // The human action is always recorded, even though the worker applies PAUSED.
    expect(published.map((event) => event.type)).toContain("HUMAN_PAUSED_TASK");
  });

  it("refuses a pause the control table forbids", async () => {
    const { service, worker } = buildService({
      tasks: [taskRecord({ status: "DONE", approved: true })],
    });

    await expect(service.pauseTask("TASK-001")).rejects.toMatchObject({ status: 409 });
    // Refused before touching the worker.
    expect(worker.calls).toHaveLength(0);
  });

  it("404s an unknown task instead of silently succeeding", async () => {
    const { service } = buildService();
    await expect(service.pauseTask("TASK-404")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a duplicate external id rather than overwriting a task", async () => {
    const { service } = buildService();
    await expect(
      service.createTask({ title: "dup", description: "dup" , externalId: "TASK-001" }),
    ).rejects.toMatchObject({ status: 409, code: "duplicate_task" });
  });
});
