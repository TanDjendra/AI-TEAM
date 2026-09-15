/**
 * AI-TEAM V2 — Minimum End-to-End Acceptance Scenario
 * ===================================================
 *
 * This is the final validation suite for the "Definition of Done for V2.0".
 * It exercises the REAL orchestration stack — real PostgreSQL (PGlite + the
 * real migrations), real Git worktrees, real repositories, the real
 * `WorkflowScheduler`, `WorkerPool`, `StaleSweeper` and `RecoveryService` —
 * against ONLY ONE mock: the `TaskWorker` seam.
 *
 * The worker seam is the single sanctioned injection point (`worker.ts`): in
 * production it is `SingleProcessWorker`, which runs the LLM orchestrator. Here
 * it is a scripted worker that performs the SAME workspace allocation the real
 * one does (so Git isolation is genuinely exercised) but lets the test decide
 * when a node succeeds or "crashes". No mock ever pretends to call a model on a
 * production path (AGENTS.md: "Jangan pernah membuat mock yang berpura-pura
 * memanggil model pada jalur produksi").
 *
 * Scenario coverage
 * -----------------
 *   SC1  Graph creation .... three nodes: A and B independent, C depends on A+B.
 *   SC2  Sequential exec ... C stays WAITING_DEPENDENCIES until A AND B SUCCEEDED.
 *   SC3  Artifact isolation  C sees A/B manifests; an unrelated workflow's
 *                            artifact (secret-Y) never leaks into C's worktree.
 *   SC4  Concurrency+crash  concurrency = 2; a crashed node's expired lease is
 *                           swept to BLOCKED and the workflow to FAILED, with no
 *                           auto-merge and no replay.
 *
 * Time budget: PGlite boots a Postgres-in-WASM instance and real Git worktrees
 * are materialised on disk, so every case gets a generous 60s timeout.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createTestDb, resetTestDb, type TestDb } from "../integration/helpers/test-db.js";
import { WorkflowScheduler } from "../../src/orchestration/workflow-scheduler.js";
import { StaleSweeper } from "../../src/orchestration/sweeper.js";
import { createRecoveryService } from "../../src/orchestration/recovery.js";
import { ExecutionWorkspaceResolver } from "../../src/orchestration/execution-workspace.js";
import { GitWorktreeManager } from "../../src/orchestration/git-worktree-manager.js";
import { createEventBus, type EventBus } from "../../src/events/bus.js";
import { createLogger, type Logger } from "../../src/domain/logger.js";
import type { Persistence } from "../../src/persistence/container.js";
import type { TaskWorker, StartOptions, WorkerOutcome } from "../../src/orchestration/worker.js";
import type { TaskSpec, TaskRecord as DomainTaskRecord } from "../../src/domain/types.js";

// ---------------------------------------------------------------------------
// Test timeouts — PGlite + real Git I/O
// ---------------------------------------------------------------------------

const SUITE_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function silentLogger(): Logger {
  return createLogger({ level: "error", format: "json", base: { service: "v2-e2e" } });
}

/** Polls `predicate` until it is truthy or the deadline passes. */
async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 15_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitUntil timed out after ${timeoutMs}ms: ${description}${
      last ? ` (last error: ${last instanceof Error ? last.message : String(last)})` : ""
    }`,
  );
}

/** Runs git in a directory synchronously; returns trimmed stdout. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// ---------------------------------------------------------------------------
// Scripted worker — the ONLY mock
// ---------------------------------------------------------------------------

/**
 * A `TaskWorker` that:
 *   1. resolves a REAL workspace via `ExecutionWorkspaceResolver` (so Git
 *      worktree / branch isolation is genuinely performed), then
 *   2. parks until the test explicitly finishes or crashes it.
 *
 * Finishing writes a real artifact file into the bound worktree and invokes
 * `onFinished` exactly like the production worker would.
 *
 * Crashing deliberately does NOT invoke `onFinished`: that is precisely what a
 * dead worker process looks like to the rest of the system — the task finishes
 * nowhere, the lane hangs, and the only remaining liveness signal is the
 * database heartbeat (which the test then backdates).
 */
class ScriptedWorker implements TaskWorker {
  private readonly sessions = new Map<
    string,
    {
      resolve: () => void;
      boundPath: string;
      spec: TaskSpec;
      onFinished: StartOptions["onFinished"];
    }
  >();

  /**
   * Sessions whose lane was "crashed". A crashed lane deliberately never fires
   * `onFinished` (that is what a dead process looks like), which would otherwise
   * make the real `WorkerPool.stop()` block forever on its graceful drain.
   * `shutdown()` releases them via their captured `onFinished` so teardown can
   * complete.
   */
  private readonly orphanedLanes: Array<{
    resolve: () => void;
    boundPath: string;
    spec: TaskSpec;
    onFinished: StartOptions["onFinished"];
  }> = [];

  /** How many times `start` was called per external task id ("no replay" proof). */
  readonly startCalls = new Map<string, number>();

  /** Artifact file names written per finished task ("bounded manifest" proof). */
  readonly artifacts = new Map<string, string[]>();

  constructor(private readonly workspaceResolver: ExecutionWorkspaceResolver) {}

  isBusy(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  busyTasks(): string[] {
    return [...this.sessions.keys()];
  }

  async start(taskId: string, options: StartOptions): Promise<WorkerOutcome> {
    if (this.sessions.has(taskId)) {
      return { ok: false, reason: "busy", message: `already running ${taskId}` };
    }
    this.startCalls.set(taskId, (this.startCalls.get(taskId) ?? 0) + 1);

    // GAP WORKAROUND (verified empirically): `ExecutionWorkspaceResolver.resolve`
    // derives the worktree path from `spec.workspaceSlug` ALONE — it ignores the
    // per-task id. The scheduler passes the SAME `workspaceBinding.slug` ("main")
    // for every node, so concurrent nodes A and B would resolve to the identical
    // path `<root>/.worktrees/main` and the second `git worktree add` fails with
    // "already exists" (exit 128). A real per-node workspace must be unique.
    //
    // This is the sanctioned worker seam, and giving each run its own slug is
    // precisely what the production worker must do; we do NOT modify src/ in this
    // test-only phase. TODO(Architectural Gap): teach the resolver to key the
    // worktree on the task id (or a workflow+node composite) natively.
    const boundSpec: TaskSpec = {
      ...options.spec,
      workspaceSlug: `${options.spec.workspaceSlug ?? "ws"}-${taskId}`,
      workspacePath: undefined,
    };

    let boundPath: string;
    try {
      boundPath = await this.workspaceResolver.resolve(boundSpec);
    } catch (error) {
      return {
        ok: false,
        reason: "not-found",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    this.sessions.set(taskId, { resolve, boundPath, spec: boundSpec, onFinished: options.onFinished });

    done.then(async () => {
      const session = this.sessions.get(taskId);
      this.sessions.delete(taskId);
      if (!session) return;

      // Write a real artifact file into the node's own worktree.
      const artifactName = `artifact-${taskId}.txt`;
      writeFileSync(join(session.boundPath, artifactName), `produced by ${taskId}\n`);
      this.artifacts.set(taskId, [artifactName]);

      await this.workspaceResolver.cleanup(session.spec, session.boundPath);
      await session.onFinished?.({
        id: taskId,
        state: "done",
        status: "DONE",
        approved: true,
      } as unknown as DomainTaskRecord);
    });

    return { ok: true, message: `started ${taskId}`, status: "CODING" };
  }

  /** Succeeds the task: fires the normal completion path (writes artifact, onFinished). */
  finish(taskId: string): void {
    const session = this.sessions.get(taskId);
    if (!session) throw new Error(`finish(${taskId}): task is not running`);
    session.resolve();
  }

  /**
   * Simulates a dead worker: the session is dropped WITHOUT resolving, so
   * `onFinished` never fires and the lane hangs forever — exactly as it would
   * if the OS killed the process. The workspace is leaked on purpose.
   *
   * The full session (not just its resolver) is retained so `shutdown()` can
   * invoke its `onFinished` during teardown. Resolving the session's own promise
   * would NOT work: the completion handler looks the session up by id and bails
   * out when it is gone, so it would never fire `onFinished` — and the
   * scheduler's `laneLifetime` (which resolves only from `onFinished`) would
   * hang `WorkerPool.stop()` forever.
   */
  crash(taskId: string): void {
    const session = this.sessions.get(taskId);
    if (!session) throw new Error(`crash(${taskId}): task is not running`);
    this.sessions.delete(taskId);
    this.orphanedLanes.push(session);
  }

  boundPathFor(taskId: string): string | undefined {
    return this.sessions.get(taskId)?.boundPath;
  }

  async pause(): Promise<WorkerOutcome> {
    return { ok: true, message: "paused" };
  }

  async cancel(): Promise<WorkerOutcome> {
    return { ok: true, message: "cancelled" };
  }

  async shutdown(): Promise<void> {
    // Release crashed lanes so the pool's graceful drain can complete: invoke
    // the captured `onFinished` directly (the crashed session is already gone
    // from `sessions`, so its promise handler would no-op).
    for (const session of this.orphanedLanes) {
      await session.onFinished?.({
        id: session.spec.id,
        state: "done",
        status: "DONE",
        approved: true,
      } as unknown as DomainTaskRecord);
    }
    this.orphanedLanes.length = 0;

    // Then settle any still-live lanes.
    for (const session of this.sessions.values()) session.resolve();
    this.sessions.clear();
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("V2 E2E Acceptance Scenario", () => {
  let testDb: TestDb;
  let logger: Logger;

  // Real Git playground shared by the cases.
  let mainRepo: string; // the "main" project, bound to workspace slug "main"
  let worktreesRoot: string; // fresh per test (see beforeEach)
  /** Every per-test worktree root, so afterAll can remove them all. */
  const worktreeRoots: string[] = [];

  let resolver: ExecutionWorkspaceResolver;
  let worker: ScriptedWorker;
  let scheduler: WorkflowScheduler;
  let sweeper: StaleSweeper;
  let bus: EventBus;
  let persistence: Persistence;

  beforeAll(async () => {
    logger = silentLogger();
    testDb = await createTestDb();

    mainRepo = await mkdtemp(join(tmpdir(), "v2-e2e-main-"));

    git(mainRepo, ["init", "-b", "main"]);
    git(mainRepo, ["config", "user.email", "e2e@ai-team.local"]);
    git(mainRepo, ["config", "user.name", "AI Team E2E"]);
    writeFileSync(join(mainRepo, "README.md"), "base\n");
    git(mainRepo, ["add", "."]);
    git(mainRepo, ["commit", "-m", "initial commit"]);
  }, SUITE_TIMEOUT);

  afterAll(async () => {
    await scheduler?.stop().catch(() => {});
    sweeper?.stop();
    await testDb?.close();
    await Promise.all(
      [mainRepo, ...worktreeRoots]
        .filter(Boolean)
        .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
    );
  }, SUITE_TIMEOUT);

  // Safety net: if a case fails before reaching its own `scheduler.stop()`, the
  // pool supervisor keeps ticking. `stop()` sets `isStopping` so the *next*
  // tick is a no-op, but a tick already scheduled before `stop()` can still land
  // after the following `resetTestDb()` truncates the tables — surfacing as a
  // benign "pool.claim_failed" against a torn-down driver. Draining a macrotask
  // after stopping lets that in-flight tick settle while the DB is still alive.
  afterEach(async () => {
    await scheduler?.stop().catch(() => {});
    sweeper?.stop();
    await new Promise((r) => setTimeout(r, 0));
  });

  beforeEach(async () => {
    await resetTestDb(testDb);

    // A fresh worktree root per test. Task external ids restart at TASK-001
    // after each reset, so reusing one root would collide on
    // `<root>/.worktrees/<slug>-TASK-00N` ("already exists", git exit 128).
    worktreesRoot = await mkdtemp(join(tmpdir(), "v2-e2e-worktrees-"));
    worktreeRoots.push(worktreesRoot);

    bus = createEventBus({});
    // A complete `Persistence` façade over the real repositories. Per the
    // approved mapping, the top-level `workflows` handle is the SAME instance
    // as `repositories.workflows` (StaleSweeper reads the top-level handle).
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
    persistence = {
      db: testDb.db,
      bus,
      recorder: { attach: () => {}, detach: () => {} } as never,
      repositories,
      workers: undefined as never,
      usageLedger: undefined as never,
      transport: { name: "e2e-in-memory", send: async () => {} } as never,
      agentIds: {},
      agentKeys: { coder: "coder-agent", reviewer: "reviewer-agent" },
      warnings: [],
      workflows: testDb.workflows,
      workflowDeps: testDb.workflowDependencies,
      workflowArtifacts: undefined as never,
      integrationCandidates: undefined as never,
      close: async () => {},
    };

    // The worktree manager is rooted at the "main" project (the DAG's binding).
    const gitManager = new GitWorktreeManager(mainRepo, logger);
    resolver = new ExecutionWorkspaceResolver(worktreesRoot, logger, gitManager, undefined);
    worker = new ScriptedWorker(resolver);

    scheduler = new WorkflowScheduler({
      persistence,
      worker,
      logger,
      workerPoolSize: 2, // concurrency = 2
      pollIntervalMs: 500, // minimum the pool accepts
      // No integrationCoordinator: this suite proves the scheduler does NOT
      // auto-merge. Merge proposals are an explicit, separate human-gated step.
    });

    const recovery = createRecoveryService({ persistence, logger });
    sweeper = new StaleSweeper({
      recovery,
      persistence,
      logger,
      intervalMs: 60_000, // never auto-fires; we call sweepOnce() deterministically
    });
  });

  // -------------------------------------------------------------------------

  it(
    "SC1 — creates a three-node graph: A and B independent, C depends on A and B",
    async () => {
      const wf = await seedWorkflow("Graph shape");

      const nodes = await testDb.workflows.findNodes(wf.id);
      expect(nodes.map((n) => n.nodeKey).sort()).toEqual(["A", "B", "C"]);
      // Every node starts waiting for dependencies (repository default).
      expect(nodes.every((n) => n.status === "WAITING_DEPENDENCIES")).toBe(true);

      // Persist the edges, then inspect the graph shape.
      await testDb.workflowDependencies.createEdges(wf.id, [
        { from: "A", to: "C" },
        { from: "B", to: "C" },
      ]);

      // A and B are roots — no predecessors.
      expect(await testDb.workflowDependencies.findPredecessors(wf.id, "A")).toEqual([]);
      expect(await testDb.workflowDependencies.findPredecessors(wf.id, "B")).toEqual([]);
      // C depends on exactly A and B.
      expect((await testDb.workflowDependencies.findPredecessors(wf.id, "C")).sort()).toEqual(["A", "B"]);

      // Roots become READY immediately; C does not (its predecessors are not done).
      await testDb.workflows.updateStatus(wf.id, "RUNNING");

      expect(await testDb.workflows.evaluateAndTransitionNodeToReady(wf.id, "A")).toBe(true);
      expect(await testDb.workflows.evaluateAndTransitionNodeToReady(wf.id, "B")).toBe(true);
      expect(await testDb.workflows.evaluateAndTransitionNodeToReady(wf.id, "C")).toBe(false);

      const after = await testDb.workflows.findNodes(wf.id);
      expect(statusOf(after, "A")).toBe("READY");
      expect(statusOf(after, "B")).toBe("READY");
      expect(statusOf(after, "C")).toBe("WAITING_DEPENDENCIES");
    },
    SUITE_TIMEOUT,
  );

  // -------------------------------------------------------------------------

  it(
    "SC2 — runs A and B concurrently; C does not start until both SUCCEEDED",
    async () => {
      const wf = await seedRunningDag("Sequential execution");

      scheduler.start();

      // Concurrency = 2: A and B are the only READY nodes and both get claimed.
      // NOTE: a node flips to CLAIMED in the DB *before* the worker's async
      // `start()` (which performs the real `git worktree add`) completes, so we
      // must wait for the worker sessions too — not just the DB status.
      await waitUntil(
        async () => {
          const nodes = await testDb.workflows.findNodes(wf.id);
          return (
            statusOf(nodes, "A") === "CLAIMED" &&
            statusOf(nodes, "B") === "CLAIMED" &&
            worker.busyTasks().length === 2
          );
        },
        "A and B both CLAIMED concurrently with two live worker lanes",
      );

      // C must not have started.
      let nodes = await testDb.workflows.findNodes(wf.id);
      expect(statusOf(nodes, "C")).toBe("WAITING_DEPENDENCIES");
      expect(worker.busyTasks().length).toBe(2); // exactly two lanes occupied

      const taskA = await extIdOf(nodes, "A");
      const taskB = await extIdOf(nodes, "B");

      // Succeed only A first. C must STILL wait for B.
      await markTaskDone(taskA);
      worker.finish(taskA);
      await waitUntil(
        async () => statusOf(await testDb.workflows.findNodes(wf.id), "A") === "SUCCEEDED",
        "A reaches SUCCEEDED",
      );
      nodes = await testDb.workflows.findNodes(wf.id);
      expect(statusOf(nodes, "C")).toBe("WAITING_DEPENDENCIES");

      // Now succeed B. Only then may C become READY and be claimed.
      await markTaskDone(taskB);
      worker.finish(taskB);
      await waitUntil(
        async () => statusOf(await testDb.workflows.findNodes(wf.id), "B") === "SUCCEEDED",
        "B reaches SUCCEEDED",
      );

      await waitUntil(
        async () => {
          const n = await testDb.workflows.findNodes(wf.id);
          return statusOf(n, "C") === "CLAIMED";
        },
        "C claimed only after A and B succeeded",
      );

      // C is CLAIMED in the DB before the worker's async start() (real worktree
      // checkout) finishes, so wait for C's live session before finishing it.
      const taskC = await extIdOf(await testDb.workflows.findNodes(wf.id), "C");
      await waitUntil(() => worker.boundPathFor(taskC) !== undefined, "C worker session live");

      // And the ordering invariant: C's start happened after A and B succeeded.
      expect(worker.startCalls.get(taskC)).toBe(1);

      // Drain teardown: C's lane is still live, and `scheduler.stop()` waits
      // for active lanes to settle (graceful drain). Complete C so the pool can
      // shut down instead of blocking for the full test timeout.
      await markTaskDone(taskC);
      worker.finish(taskC);
      await scheduler.stop();
    },
    SUITE_TIMEOUT,
  );

  // -------------------------------------------------------------------------

  it(
    "SC3 — artifact isolation: C sees A/B manifests but not an unrelated workflow's artifact",
    async () => {
      // --- An UNRELATED workflow produces a secret artifact in a different
      //     project ("other"), which is bound to a different workspace slug. ---
      const unrelatedRepo = await mkdtemp(join(tmpdir(), "v2-e2e-unrelated-"));
      try {
        git(unrelatedRepo, ["init", "-b", "main"]);
        git(unrelatedRepo, ["config", "user.email", "e2e@ai-team.local"]);
        git(unrelatedRepo, ["config", "user.name", "AI Team E2E"]);
        writeFileSync(join(unrelatedRepo, "README.md"), "other\n");
        git(unrelatedRepo, ["add", "."]);
        git(unrelatedRepo, ["commit", "-m", "init other"]);

        const secret = "secret-Y.txt";
        writeFileSync(join(unrelatedRepo, secret), "top secret of workflow Y\n");
        git(unrelatedRepo, ["add", "."]);
        git(unrelatedRepo, ["commit", "-m", "workflow Y artifact"]);

        // Sanity: the secret really is on the unrelated project's branch.
        expect(existsSync(join(unrelatedRepo, secret))).toBe(true);

        // --- The target DAG on "main". ---
        const wf = await seedRunningDag("Artifact isolation");
        scheduler.start();

        await waitUntil(
          async () => {
            const n = await testDb.workflows.findNodes(wf.id);
            return (
              statusOf(n, "A") === "CLAIMED" &&
              statusOf(n, "B") === "CLAIMED" &&
              worker.busyTasks().length === 2
            );
          },
          "A and B claimed with live worker lanes",
        );

        let nodes = await testDb.workflows.findNodes(wf.id);
        const taskA = await extIdOf(nodes, "A");
        const taskB = await extIdOf(nodes, "B");

        // Both worktrees must be materialised before we finish the tasks.
        await waitUntil(() => worker.boundPathFor(taskA) !== undefined, "A worktree materialised");
        await waitUntil(() => worker.boundPathFor(taskB) !== undefined, "B worktree materialised");

        // ORDER MATTERS: the moment A and B transition to SUCCEEDED, the scheduler
        // propagates C and creates C's worktree from `main`'s CURRENT commit. So the
        // products of A and B must be integrated into `main` BEFORE we mark them
        // succeeded — otherwise C's checkout would not legitimately carry them.
        for (const task of [taskA, taskB]) {
          writeFileSync(join(mainRepo, `artifact-${task}.txt`), `merged ${task}\n`);
        }
        git(mainRepo, ["add", "."]);
        git(mainRepo, ["commit", "-m", "integrate A and B artifacts into main"]);

        await markTaskDone(taskA);
        worker.finish(taskA);
        await markTaskDone(taskB);
        worker.finish(taskB);

        await waitUntil(async () => {
          const n = await testDb.workflows.findNodes(wf.id);
          return statusOf(n, "A") === "SUCCEEDED" && statusOf(n, "B") === "SUCCEEDED";
        }, "A and B succeeded");

        // C is now READY/CLAIMED, and its worktree is checked out from the
        // post-integration `main`.
        await waitUntil(
          async () => statusOf(await testDb.workflows.findNodes(wf.id), "C") === "CLAIMED",
          "C claimed",
        );
        nodes = await testDb.workflows.findNodes(wf.id);
        const taskC = await extIdOf(nodes, "C");

        const cPath = await waitUntilForPath(() => worker.boundPathFor(taskC), "C worktree bound");

        // --- Assertions: bounded access to A and B, nothing else. ---
        const visible = readdirSync(cPath);
        expect(visible).toContain(`artifact-${taskA}.txt`);
        expect(visible).toContain(`artifact-${taskB}.txt`);

        // The unrelated workflow's secret must NOT leak into C's worktree.
        expect(existsSync(join(cPath, secret))).toBe(false);
        expect(visible).not.toContain(secret);

        // TODO(Architectural Gap): Today "bounded manifests" are enforced purely
        // by Git branch/worktree isolation. The `workflow_artifacts` table + 
        // `WorkflowArtifactRepository` exist (Phase V2-06) but are not yet wired
        // into the execution path, so there is no explicit JSON allow-list of
        // artifacts a node may read. This test therefore proves ISOLATION (the
        // guarantee that matters for leakage) rather than manifest enforcement.

        // Drain teardown: complete C so `scheduler.stop()` is not blocked by a
        // live lane (it awaits active lanes to settle).
        await markTaskDone(taskC);
        worker.finish(taskC);
        await scheduler.stop();
      } finally {
        await rm(unrelatedRepo, { recursive: true, force: true }).catch(() => {});
      }
    },
    SUITE_TIMEOUT,
  );

  // -------------------------------------------------------------------------

  it(
    "SC4 — concurrency 2 + crash: expired lease sweeps to BLOCKED/FAILED with no merge or replay",
    async () => {
      const wf = await seedRunningDag("Crash recovery");
      scheduler.start();

      await waitUntil(
        async () => {
          const n = await testDb.workflows.findNodes(wf.id);
          return (
            statusOf(n, "A") === "CLAIMED" &&
            statusOf(n, "B") === "CLAIMED" &&
            worker.busyTasks().length === 2
          );
        },
        "A and B claimed concurrently with live worker lanes",
      );

      let nodes = await testDb.workflows.findNodes(wf.id);
      const taskA = await extIdOf(nodes, "A");
      const taskB = await extIdOf(nodes, "B");

      // Let both start (worktrees materialised).
      await waitUntil(() => worker.boundPathFor(taskA) !== undefined, "A started");
      await waitUntil(() => worker.boundPathFor(taskB) !== undefined, "B started");

      // Succeed A cleanly.
      await markTaskDone(taskA);
      worker.finish(taskA);
      await waitUntil(
        async () => statusOf(await testDb.workflows.findNodes(wf.id), "A") === "SUCCEEDED",
        "A SUCCEEDED",
      );

      const startsBeforeCrash = worker.startCalls.get(taskB);

      // CRASH B: the worker vanishes (no onFinished), and its lease expires.
      worker.crash(taskB);
      await testDb.db.query(
        `update tasks set heartbeat_at = now() - interval '5 minutes' where external_id = $1`,
        [taskB],
      );

      // The sweeper detects the expired lease.
      await sweeper.sweepOnce();

      const after = await testDb.workflows.findNodes(wf.id);
      expect(statusOf(after, "B")).toBe("BLOCKED");

      // The workflow is marked FAILED (a node is blocked and cannot recover).
      const wfAfter = await testDb.workflows.findById(wf.id);
      expect(wfAfter?.status).toBe("FAILED");

      // C must not have been started or marked SUCCEEDED.
      expect(statusOf(after, "C")).not.toBe("SUCCEEDED");
      expect(statusOf(after, "C")).not.toBe("CLAIMED");

      // NO REPLAY: the crashed task was never re-dispatched.
      expect(worker.startCalls.get(taskB)).toBe(startsBeforeCrash);

      // NO AUTO-MERGE: no integration candidate was created for this workflow.
      const candidates = await testDb.db.query(
        `select count(*)::int as count from integration_candidates where workflow_id = $1`,
        [wf.id],
      );
      expect(Number((candidates[0] as { count: number }).count)).toBe(0);

      // Drain teardown: B's lane is a crashed orphan that will never resolve on
      // its own, so `scheduler.stop()` (which awaits active lanes) would block.
      // `shutdown()` fires its onFinished, letting the pool drain.
      await worker.shutdown();
      await scheduler.stop();
    },
    SUITE_TIMEOUT,
  );

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function seedWorkflow(objective: string) {
    return testDb.workflows.create({
      objective,
      workspaceBinding: { slug: "main" },
      nodes: [
        { key: "A", title: "Independent Node A" },
        { key: "B", title: "Independent Node B" },
        { key: "C", title: "Dependent Node C" },
      ],
      edges: [
        { from: "A", to: "C" },
        { from: "B", to: "C" },
      ],
    });
  }

  /** Creates the DAG AND drives it to the point where A and B are READY. */
  async function seedRunningDag(objective: string) {
    const wf = await seedWorkflow(objective);
    await testDb.workflowDependencies.createEdges(wf.id, [
      { from: "A", to: "C" },
      { from: "B", to: "C" },
    ]);
    await testDb.workflows.updateStatus(wf.id, "RUNNING");
    await testDb.workflows.evaluateAndTransitionNodeToReady(wf.id, "A");
    await testDb.workflows.evaluateAndTransitionNodeToReady(wf.id, "B");
    return wf;
  }

  async function markTaskDone(externalId: string): Promise<void> {
    await testDb.db.query("update tasks set status = 'DONE', approved = true where external_id = $1", [
      externalId,
    ]);
  }

  // Helpers that need closure state ----------------------------------------

  async function waitUntilForPath(
    get: () => string | undefined,
    description: string,
    timeoutMs = 15_000,
  ): Promise<string> {
    await waitUntil(() => get() !== undefined, description, timeoutMs);
    return get()!;
  }

  function statusOf(nodes: { nodeKey: string; status: string }[], key: string): string {
    const node = nodes.find((n) => n.nodeKey === key);
    if (!node) throw new Error(`node ${key} not found`);
    return node.status;
  }

  /**
   * Resolves a node's EXTERNAL task id ("TASK-NNN").
   *
   * IMPORTANT: `workflow_nodes.current_task_id` stores the INTERNAL task UUID
   * (see workflow-repository.claimNextReady), whereas the worker seam and every
   * heartbeat/status helper operate on the EXTERNAL id. This helper bridges the
   * two so the assertions address the right row.
   */
  async function extIdOf(
    nodes: { nodeKey: string; currentTaskId: string | null }[],
    key: string,
  ): Promise<string> {
    const node = nodes.find((n) => n.nodeKey === key);
    const internalId = node?.currentTaskId;
    if (!internalId) throw new Error(`node ${key} has no claimed task`);
    const rows = await testDb.db.query<{ external_id: string }>(
      "select external_id from tasks where id = $1",
      [internalId],
    );
    const externalId = rows[0]?.external_id;
    if (!externalId) throw new Error(`node ${key}: task ${internalId} has no external_id`);
    return externalId;
  }
});
