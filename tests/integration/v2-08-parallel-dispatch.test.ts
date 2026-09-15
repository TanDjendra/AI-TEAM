/**
 * Phase V2-08 — Parallel Dispatch & Worker Pool Concurrency tests.
 *
 * These tests verify:
 *   1. WorkerPool spawns concurrent lanes and tracks them correctly
 *   2. Graceful shutdown drains all active lanes
 *   3. Sequential claim when no work is available
 *   4. FOR UPDATE SKIP LOCKED prevents double-claiming (sequential proof)
 *   5. WorkflowScheduler dispatches through the pool
 *   6. Config validation (WORKER_POOL_SIZE clamping)
 *
 * All DB tests run against real PostgreSQL (PGlite) — no mocks.
 *
 * IMPORTANT: PGlite serialises all connections through a single mutex, so
 * truly concurrent transactions are not possible. The tests prove correctness
 * via sequential claims that exercise the same code paths the real Postgres
 * pool would run concurrently.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestDb,
  resetTestDb,
  type TestDb,
} from "./helpers/test-db.js";
import { WorkerPool } from "../../src/orchestration/worker-pool.js";
import { WorkflowScheduler } from "../../src/orchestration/workflow-scheduler.js";
import { loadConfig, describeConfig, type AppConfig } from "../../src/config/env.js";
import { createLogger, type Logger } from "../../src/domain/logger.js";
import type { WorkflowSpec } from "../../src/domain/workflow.js";
import type { TaskWorker, StartOptions, WorkerOutcome } from "../../src/orchestration/worker.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function silentLogger(): Logger {
  return createLogger({ level: "error", format: "json", base: { service: "test" } });
}

/** A TaskWorker stub that records start calls and holds tasks until manually released. */
class ControllableWorker implements TaskWorker {
  readonly started: Array<{ taskId: string; options: StartOptions }> = [];
  private readonly running = new Map<string, { resolve: () => void }>();

  async start(taskId: string, options: StartOptions): Promise<WorkerOutcome> {
    this.started.push({ taskId, options });

    if (this.running.has(taskId)) {
      return { ok: false, reason: "busy", message: `already running ${taskId}` };
    }

    // Mark as running — the onFinished callback fires when finishTask() is called.
    let resolveFn!: () => void;
    const done = new Promise<void>((resolve) => { resolveFn = resolve; });
    this.running.set(taskId, { resolve: resolveFn });

    // Wire the completion: when finishTask() resolves the promise, fire onFinished.
    done.then(async () => {
      this.running.delete(taskId);
      const fakeRecord = {
        id: taskId,
        state: "done" as const,
        title: "",
        description: "",
        status: "DONE",
        approved: true,
        coderCycles: 0,
        reviewCycles: 0,
        events: [],
      } as any;
      try {
        await options.onFinished?.(fakeRecord);
      } catch {
        // Swallow — test may have shut down
      }
    });

    return { ok: true, message: `started ${taskId}`, status: "CODING" };
  }

  /** Simulate task completion — fires the onFinished callback. */
  finishTask(taskId: string): void {
    const entry = this.running.get(taskId);
    if (entry) entry.resolve();
  }

  /** Finish all running tasks. */
  finishAll(): void {
    for (const entry of this.running.values()) entry.resolve();
  }

  isBusy(taskId: string): boolean {
    return this.running.has(taskId);
  }

  busyTasks(): string[] {
    return [...this.running.keys()];
  }

  async pause(): Promise<WorkerOutcome> {
    return { ok: true, message: "paused" };
  }

  async cancel(): Promise<WorkerOutcome> {
    return { ok: true, message: "cancelled" };
  }

  async shutdown(): Promise<void> {
    this.finishAll();
  }
}

/**
 * Creates and seeds a diamond-shaped DAG:
 *
 *     A (root)
 *    / \
 *   B   C  (parallel leaves)
 *    \ /
 *     D (join)
 *
 * Nodes B and C are independent — the scheduler should dispatch both concurrently.
 */
async function seedDiamondWorkflow(
  testDb: TestDb,
): Promise<{ workflowId: string; spec: WorkflowSpec }> {
  const spec: WorkflowSpec = {
    objective: "V2-08 parallel dispatch test",
    workspaceBinding: { path: "/tmp/v2-08-test" },
    nodes: [
      { key: "A", title: "Root task" },
      { key: "B", title: "Parallel branch B" },
      { key: "C", title: "Parallel branch C" },
      { key: "D", title: "Join task" },
    ],
    edges: [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
      { from: "C", to: "D" },
    ],
  };

  const workflow = await testDb.workflows.create(spec);
  await testDb.workflowDependencies.createEdges(workflow.id, spec.edges);
  await testDb.workflows.updateStatus(workflow.id, "VALIDATED");

  return { workflowId: workflow.id, spec };
}

/** Marks node A as SUCCEEDED and transitions B, C to READY. */
async function completeRootNode(
  testDb: TestDb,
  workflowId: string,
): Promise<void> {
  // Transition A: WAITING_DEPENDENCIES → READY (root has no predecessors)
  await testDb.workflows.evaluateAndTransitionNodeToReady(workflowId, "A");

  // Simulate A being claimed, run, and succeeded
  const taskA = await testDb.tasks.createAuto({
    title: "Root task",
    description: "Root",
    workspace: "/tmp/v2-08-test",
    maxReviewCycles: 3,
    assignedAgentId: undefined,
  });

  await testDb.workflows.updateNodeStatus(workflowId, "A", "CLAIMED", taskA.id);
  await testDb.workflows.updateNodeStatus(workflowId, "A", "SUCCEEDED");
  await testDb.workflows.updateStatus(workflowId, "RUNNING");

  // Now propagate — B and C should become READY
  await testDb.workflows.evaluateAndTransitionNodeToReady(workflowId, "B");
  await testDb.workflows.evaluateAndTransitionNodeToReady(workflowId, "C");
}

// ---------------------------------------------------------------------------
// WorkerPool unit tests (no database)
// ---------------------------------------------------------------------------

describe("V2-08 — WorkerPool (unit)", () => {
  it("spawns up to poolSize concurrent lanes", async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const claims: number[] = [];

    let resolvers: Array<() => void> = [];

    const pool = new WorkerPool({
      poolSize: 3,
      tryClaimWork: async () => {
        const id = claims.length + 1;
        claims.push(id);
        if (id > 3) return null; // Only 3 units of work

        concurrentCount++;
        if (concurrentCount > maxConcurrent) maxConcurrent = concurrentCount;

        return {
          laneLifetime: new Promise<void>((resolve) => {
            resolvers.push(() => {
              concurrentCount--;
              resolve();
            });
          })
        };
      },
      pollIntervalMs: 5000, // Long interval — we test the first tick only
      logger: silentLogger(),
    });

    pool.start();

    // Wait for the first tick to fill all 3 slots
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should have claimed 3 tasks + 1 "no work" probe
    expect(claims.length).toBeGreaterThanOrEqual(3);
    expect(pool.activeCount).toBe(3);
    expect(pool.capacity).toBe(0);

    // Release all lanes
    for (const r of resolvers) r();
    await pool.stop();
  });

  it("stop() drains active lanes before resolving", async () => {
    let taskFinished = false;

    const pool = new WorkerPool({
      poolSize: 1,
      tryClaimWork: async () => {
        return {
          laneLifetime: new Promise<void>((resolve) => {
            setTimeout(() => {
              taskFinished = true;
              resolve();
            }, 300);
          })
        };
      },
      pollIntervalMs: 5000,
      logger: silentLogger(),
    });

    pool.start();
    // Wait for the first tick to launch the lane
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(pool.activeCount).toBe(1);
    expect(taskFinished).toBe(false);

    // stop() must wait for the 300ms lane
    await pool.stop();
    expect(taskFinished).toBe(true);
  });

  it("ticks repeatedly when no work is found", async () => {
    let tickCount = 0;

    const pool = new WorkerPool({
      poolSize: 2,
      tryClaimWork: async () => {
        tickCount++;
        return null; // no work
      },
      pollIntervalMs: 100, // Clamped to 500ms by the constructor
      logger: silentLogger(),
    });

    pool.start();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await pool.stop();

    // Should have ticked at least twice (first immediate + at least one interval)
    expect(tickCount).toBeGreaterThanOrEqual(2);
  });

  it("reports correct activeCount and capacity", async () => {
    let resolveTask!: () => void;
    let callCount = 0;

    const pool = new WorkerPool({
      poolSize: 4,
      tryClaimWork: async () => {
        callCount++;
        if (callCount > 1) return null; // Only one unit of work

        return {
          laneLifetime: new Promise<void>((resolve) => {
            resolveTask = resolve;
          })
        };
      },
      pollIntervalMs: 5000,
      logger: silentLogger(),
    });

    expect(pool.activeCount).toBe(0);
    expect(pool.capacity).toBe(4);

    pool.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(pool.activeCount).toBe(1);
    expect(pool.capacity).toBe(3);

    resolveTask();
    await pool.stop();

    expect(pool.activeCount).toBe(0);
  });

  it("re-polls immediately when work is found to fill remaining slots", async () => {
    const claimTimes: number[] = [];
    let callCount = 0;
    const resolvers: Array<() => void> = [];

    const pool = new WorkerPool({
      poolSize: 2,
      tryClaimWork: async () => {
        callCount++;
        claimTimes.push(Date.now());

        if (callCount <= 2) {
          // First 2 calls find work
          return {
            laneLifetime: new Promise<void>((resolve) => {
              resolvers.push(resolve);
            })
          };
        }
        return null;
      },
      pollIntervalMs: 5000, // Long interval — only immediate re-poll should fill slot 2
      logger: silentLogger(),
    });

    pool.start();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Both slots should be filled (immediate first tick + immediate re-poll)
    expect(pool.activeCount).toBe(2);

    // Clean up
    for (const r of resolvers) r();
    await pool.stop();
  });
});

// ---------------------------------------------------------------------------
// Integration tests with PGlite
// ---------------------------------------------------------------------------

describe("V2-08 — Workflow claim correctness (integration)", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb?.close();
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
  });

  it("sequential claims on two READY nodes get different nodes (no double-claim)", async () => {
    const { workflowId } = await seedDiamondWorkflow(testDb);
    await completeRootNode(testDb, workflowId);

    // Verify B and C are READY
    const readyNodes = await testDb.workflows.findReadyNodes(workflowId);
    expect(readyNodes.map((n) => n.nodeKey).sort()).toEqual(["B", "C"]);

    // Run two sequential claims — they must get different nodes.
    // PGlite serialises connections, so we prove the SQL logic
    // (SKIP LOCKED + status transition) prevents double-claim.
    const claim1 = await testDb.workflows.claimNextReady(undefined, testDb.tasks);
    const claim2 = await testDb.workflows.claimNextReady(undefined, testDb.tasks);

    expect(claim1.claimed).toBe(true);
    expect(claim2.claimed).toBe(true);

    // They must have claimed different nodes
    const claimedKeys = new Set([claim1.node!.nodeKey, claim2.node!.nodeKey]);
    expect(claimedKeys.size).toBe(2);
    expect(claimedKeys).toContain("B");
    expect(claimedKeys).toContain("C");
  });

  it("third claim returns no-ready-nodes after both leaves are claimed", async () => {
    const { workflowId } = await seedDiamondWorkflow(testDb);
    await completeRootNode(testDb, workflowId);

    // Claim B and C
    await testDb.workflows.claimNextReady(undefined, testDb.tasks);
    await testDb.workflows.claimNextReady(undefined, testDb.tasks);

    // No more READY nodes
    const claim3 = await testDb.workflows.claimNextReady(undefined, testDb.tasks);
    expect(claim3.claimed).toBe(false);
    expect(claim3.reason).toBe("no-ready-nodes");
  });

  it("no work when all nodes are WAITING_DEPENDENCIES", async () => {
    const { workflowId } = await seedDiamondWorkflow(testDb);
    // Don't complete root — all non-root nodes are WAITING_DEPENDENCIES

    const claim = await testDb.workflows.claimNextReady(undefined, testDb.tasks);
    expect(claim.claimed).toBe(false);
    expect(claim.reason).toBe("no-ready-nodes");
  });
});

describe("V2-08 — WorkflowScheduler with WorkerPool (integration)", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb?.close();
  });

  beforeEach(async () => {
    await resetTestDb(testDb);
  });

  it("dispatches parallel branches through the pool", async () => {
    const { workflowId } = await seedDiamondWorkflow(testDb);
    await completeRootNode(testDb, workflowId);

    const worker = new ControllableWorker();
    const mockPersistence = {
      db: testDb.db,
      repositories: {
        workflows: testDb.workflows,
        workflowDependencies: testDb.workflowDependencies,
        tasks: testDb.tasks,
      },
    } as any;

    const scheduler = new WorkflowScheduler({
      persistence: mockPersistence,
      worker,
      logger: silentLogger(),
      pollIntervalMs: 1000,
      workerPoolSize: 4,
    });

    scheduler.start();

    // Give the scheduler time to claim and dispatch both B and C
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // The scheduler should have started both B and C
    expect(worker.started.length).toBeGreaterThanOrEqual(2);

    // Clean up
    worker.finishAll();
    await scheduler.stop();
  }, 15_000);

  it("workerPoolSize = 1 processes one node at a time", async () => {
    const { workflowId } = await seedDiamondWorkflow(testDb);
    await completeRootNode(testDb, workflowId);

    const worker = new ControllableWorker();
    const mockPersistence = {
      db: testDb.db,
      repositories: {
        workflows: testDb.workflows,
        workflowDependencies: testDb.workflowDependencies,
        tasks: testDb.tasks,
      },
    } as any;

    const scheduler = new WorkflowScheduler({
      persistence: mockPersistence,
      worker,
      logger: silentLogger(),
      pollIntervalMs: 1000,
      workerPoolSize: 1,
    });

    scheduler.start();

    // Wait for one claim cycle
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // With poolSize = 1, exactly one task should be started
    // (the pool can't start the second until the first lane finishes)
    expect(worker.started.length).toBe(1);

    // Finish the first task and wait for the second to be claimed
    const firstTaskId = worker.started[0]!.taskId;
    await testDb.db.query(`UPDATE tasks SET status = 'DONE', approved = true WHERE external_id = $1`, [firstTaskId]);
    worker.finishTask(firstTaskId);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Now the second should be started
    expect(worker.started.length).toBe(2);

    // Clean up
    worker.finishAll();
    await scheduler.stop();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Config validation (no database)
// ---------------------------------------------------------------------------

describe("V2-08 — Config validation", () => {
  const BASE_ENV = {
    ROUTER_BASE_URL: "http://localhost:20128/v1",
    ROUTER_API_KEY: "test-key-not-a-real-secret",
    CODER_MODEL: "grip/deepseek-v4.1-flash",
    REVIEWER_MODEL: "grip/gpt-5.6-luna",
  };

  function load(env: Record<string, string | undefined>) {
    return loadConfig({ env, cwd: process.cwd(), loadDotEnv: false });
  }

  it("defaults workerPoolSize to 4", () => {
    const config = load(BASE_ENV);
    expect(config.orchestrator.workerPoolSize).toBe(4);
  });

  it("parses WORKER_POOL_SIZE from the environment", () => {
    const config = load({ ...BASE_ENV, WORKER_POOL_SIZE: "8" });
    expect(config.orchestrator.workerPoolSize).toBe(8);
  });

  it("rejects WORKER_POOL_SIZE = 0", () => {
    expect(() => load({ ...BASE_ENV, WORKER_POOL_SIZE: "0" })).toThrowError(
      /WORKER_POOL_SIZE/,
    );
  });

  it("rejects WORKER_POOL_SIZE = 99 (over max 16)", () => {
    expect(() => load({ ...BASE_ENV, WORKER_POOL_SIZE: "99" })).toThrowError(
      /WORKER_POOL_SIZE/,
    );
  });

  it("rejects non-integer WORKER_POOL_SIZE", () => {
    expect(() => load({ ...BASE_ENV, WORKER_POOL_SIZE: "abc" })).toThrowError(
      /WORKER_POOL_SIZE/,
    );
  });

  it("accepts WORKER_POOL_SIZE = 1 (sequential mode)", () => {
    const config = load({ ...BASE_ENV, WORKER_POOL_SIZE: "1" });
    expect(config.orchestrator.workerPoolSize).toBe(1);
  });

  it("accepts WORKER_POOL_SIZE = 16 (max)", () => {
    const config = load({ ...BASE_ENV, WORKER_POOL_SIZE: "16" });
    expect(config.orchestrator.workerPoolSize).toBe(16);
  });

  it("includes workerPoolSize in describeConfig output", () => {
    const config = load(BASE_ENV);
    const described = describeConfig(config);
    expect(described["orchestrator.workerPoolSize"]).toBe(4);
  });
});
