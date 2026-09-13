/**
 * Recovery service (PHASE 6).
 *
 * Handles the failure modes a human cannot see from the board:
 *
 *   stale run        a run row still RUNNING whose process is gone
 *   stale task       a non-terminal task whose heartbeat stopped
 *   crashed agent    an agent still WORKING/REVIEWING for a task nobody runs
 *
 * Design decisions that matter:
 *
 *   - Nothing is deleted. Detection records a `TASK_STALE` event and, when asked,
 *     moves the run to INTERRUPTED so the sweep does not fire forever. The task
 *     row and its whole history stay intact.
 *   - The status a stale task receives is policy, not a guess: NEEDS_HUMAN by
 *     default (a human decides), ERROR_TOLERANT when the caller prefers a retry.
 *     A task is never silently marked DONE or CANCELLED by recovery.
 *   - Detecting and acting are separate calls, so a read-only dashboard can show
 *     what is stale without changing anything.
 */

import type { Logger } from "../domain/logger.js";
import type { AnyTaskEvent, TaskStatus } from "../events/types.js";
import { makeEvent, type EventBus } from "../events/bus.js";
import type { Persistence } from "../persistence/container.js";
import type { RunRecord } from "../persistence/repositories/run-repository.js";
import type { TaskRecord } from "../persistence/repositories/task-repository.js";

export interface RecoveryOptions {
  persistence: Persistence;
  logger: Logger;
  /** Heartbeat age after which a task/run is considered abandoned. */
  staleThresholdMs?: number;
  /** Injectable clock/id for deterministic tests. */
  now?: () => Date;
  newId?: () => string;
}

export interface RecoveryPolicy {
  /** Status a stale task is moved to. `NONE` records the event only. */
  staleTaskStatus?: TaskStatus | "NONE";
  /** Move stale runs to INTERRUPTED (stops them being reported forever). */
  markRunsInterrupted?: boolean;
  /** Release agents still holding a task nobody is running. */
  releaseAgents?: boolean;
}

export interface RecoveryAction {
  taskExternalId: string;
  taskId: string;
  status: TaskStatus;
  staleForMs: number;
  runIds: string[];
  runMarked?: string;
  taskMoved?: TaskStatus;
  agentsReleased: string[];
}

export interface RecoveryReport {
  thresholdMs: number;
  scannedAt: string;
  /** Read-only scan: everything that looks abandoned. */
  detected: RecoveryAction[];
  /** Actions actually applied (empty for a dry run). */
  applied: RecoveryAction[];
  events: AnyTaskEvent[];
}

export interface RecoveryService {
  /** Read-only: what is stale right now. Never mutates. */
  detect(): Promise<RecoveryAction[]>;
  /** Detects and applies the policy. Queues a TASK_STALE event per task. */
  recover(policy?: RecoveryPolicy): Promise<RecoveryReport>;
  /** Recovery for one task, used by the dashboard's "Recover" button. */
  recoverTask(
    externalId: string,
    policy?: RecoveryPolicy,
  ): Promise<{ ok: boolean; message: string; action?: RecoveryAction }>;
}

export const DEFAULT_STALE_THRESHOLD_MS = 120_000;

export function createRecoveryService(options: RecoveryOptions): RecoveryService {
  const { persistence, logger } = options;
  const thresholdMs = Math.max(1_000, options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS);
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const repos = persistence.repositories;

  const ageOf = (task: TaskRecord, at: number): number => {
    const reference = task.heartbeatAt ?? task.startedAt ?? task.updatedAt;
    const parsed = Date.parse(reference);
    return Number.isNaN(parsed) ? 0 : Math.max(0, at - parsed);
  };

  /** Joins stale tasks to their unfinished runs. Read-only. */
  const scan = async (): Promise<RecoveryAction[]> => {
    const at = now().getTime();
    const staleTasks = await repos.tasks.listStale({ olderThanMs: thresholdMs });
    const actions: RecoveryAction[] = [];

    for (const task of staleTasks) {
      const runs = await repos.runs.listForTask(task.id);
      const running = runs.filter((run) => run.status === "RUNNING");
      actions.push({
        taskExternalId: task.externalId,
        taskId: task.id,
        status: task.status,
        staleForMs: ageOf(task, at),
        runIds: running.map((run) => run.runId),
        agentsReleased: [],
      });
    }

    // Runs that are stale even when the task row looks healthy (a run row left
    // behind by a process that died mid-way).
    const staleRuns = await repos.runs.listStale(thresholdMs);
    for (const run of staleRuns) {
      if (actions.some((action) => action.taskId === run.taskId)) continue;
      const task = await repos.tasks.findById(run.taskId);
      if (!task) continue;
      actions.push({
        taskExternalId: task.externalId,
        taskId: task.id,
        status: task.status,
        staleForMs: Math.max(0, at - Date.parse(run.startedAt)),
        runIds: [run.runId],
        agentsReleased: [],
      });
    }

    return actions;
  };

  const applyPolicy = async (
    action: RecoveryAction,
    policy: RecoveryPolicy,
  ): Promise<RecoveryAction> => {
    const task = await repos.tasks.findById(action.taskId);
    if (!task) return action;

    const applied: RecoveryAction = { ...action };

    // 1. The run row: INTERRUPTED, never deleted.
    if (policy.markRunsInterrupted !== false) {
      for (const runId of action.runIds) {
        const updated = await repos.runs
          .finish({ runId, status: "INTERRUPTED", stopReason: "STALE_RUN" })
          .catch(() => undefined);
        if (updated) applied.runMarked = "INTERRUPTED";
      }
    }

    // 2. The task row: policy decides. Default NEEDS_HUMAN — a human decides,
    //    recovery never invents success.
    const target = policy.staleTaskStatus ?? "NEEDS_HUMAN";
    if (target !== "NONE" && target !== task.status) {
      const moved = await repos.tasks
        .setStatus(task.id, target, {
          fromStatus: task.status,
          transitionSeqBump: true,
          ...(target === "NEEDS_HUMAN" ? {} : {}),
        })
        .catch(() => undefined);
      if (moved) applied.taskMoved = target;
    }

    // 3. Agents still parked on this task.
    //
    // Discovered from the database (`current_task_id`), not from an in-memory
    // agent-id map: recovery may run in a process that never started the run and
    // therefore has no such cache. Relying on the cache would silently release
    // nothing, leaving agents stuck on WORKING forever.
    if (policy.releaseAgents !== false) {
      const agents = await repos.agents.list().catch(() => []);
      for (const agent of agents) {
        if (agent.currentTaskId !== task.id) continue;
        await repos.agents.setStatus(agent.id, "IDLE", { currentTaskId: null }).catch(() => {});
        applied.agentsReleased.push(agent.agentKey);
      }
    }

    return applied;
  };

  const emitStale = async (action: RecoveryAction, applied: boolean): Promise<AnyTaskEvent | undefined> => {
    try {
      const event = makeEvent({
        type: "TASK_STALE",
        taskId: action.taskExternalId,
        newId,
        now,
        payload: {
          runId: action.runIds[0] ?? "",
          staleForMs: action.staleForMs,
          thresholdMs,
          recovery: applied ? "MARKED_INTERRUPTED" : "DETECTED_ONLY",
          message: `No heartbeat for ${Math.round(action.staleForMs / 1000)}s (threshold ${Math.round(
            thresholdMs / 1000,
          )}s)`,
        },
      });
      await persistence.bus.publish(event);
      return event;
    } catch (error) {
      logger.error("recovery.event_failed", {
        taskId: action.taskExternalId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  return {
    detect: scan,

    async recover(policy = {}): Promise<RecoveryReport> {
      const detected = await scan();
      const applied: RecoveryAction[] = [];
      const events: AnyTaskEvent[] = [];

      for (const action of detected) {
        const result = await applyPolicy(action, policy);
        applied.push(result);
        const event = await emitStale(result, true);
        if (event) events.push(event);
        logger.warn("recovery.stale_task", {
          taskId: action.taskExternalId,
          staleForMs: action.staleForMs,
          runs: action.runIds.length,
          movedTo: result.taskMoved ?? null,
        });
      }

      return { thresholdMs, scannedAt: now().toISOString(), detected, applied, events };
    },

    async recoverTask(externalId, policy = {}) {
      const task = await repos.tasks.findByExternalId(externalId);
      if (!task) return { ok: false, message: `No task ${externalId}` };

      const at = now().getTime();
      const runs = (await repos.runs.listForTask(task.id)).filter((run) => run.status === "RUNNING");

      // A manual recovery must work even when the automated threshold has not
      // elapsed: the operator is asserting the run is dead.
      const action: RecoveryAction = {
        taskExternalId: task.externalId,
        taskId: task.id,
        status: task.status,
        staleForMs: ageOf(task, at),
        runIds: runs.map((run) => run.runId),
        agentsReleased: [],
      };

      const applied = await applyPolicy(action, { markRunsInterrupted: true, ...policy });
      await emitStale(applied, true);
      logger.info("recovery.manual", {
        taskId: task.externalId,
        runsInterrupted: applied.runMarked ? action.runIds.length : 0,
        movedTo: applied.taskMoved ?? null,
      });

      return { ok: true, message: `Recovered ${task.externalId}`, action: applied };
    },
  };
}

/** Flattened view for the dashboard banner. */
export function summarizeRecovery(report: RecoveryReport): {
  staleCount: number;
  thresholdSeconds: number;
  taskIds: string[];
} {
  return {
    staleCount: report.detected.length,
    thresholdSeconds: Math.round(report.thresholdMs / 1000),
    taskIds: report.detected.map((action) => action.taskExternalId),
  };
}

export type { RunRecord, TaskRecord };
