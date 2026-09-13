/**
 * Worker abstraction (PHASE 6).
 *
 * The dashboard must control real work, not just database rows. This is the seam
 * between a human action and an orchestrator run:
 *
 *   interface TaskWorker { start / pause / cancel }
 *
 * `SingleProcessWorker` runs the orchestrator in the current process, which is
 * what the dashboard uses today. The interface exists so a queue-and-fan-out
 * worker pool can replace it without the API, the service or the UI changing —
 * only the construction in `runtime.ts`.
 *
 * Control semantics:
 *   - `start` is refused when the task is already owned by a live run. That check
 *     goes through the database (`claim`), not a local flag, so it holds even if
 *     two workers exist.
 *   - `pause`/`cancel` are *cooperative*: they record a durable interrupt and let
 *     the run unwind at a safe point. The task is not marked PAUSED/CANCELLED
 *     until the worker confirms, so the dashboard can never show a paused task
 *     that is actually still working.
 */

import type { Logger } from "../domain/logger.js";
import type { InterruptIntent } from "../domain/control.js";
import type { InterruptSignals } from "./interrupt-listener.js";
import { isTaskInterrupt } from "../domain/control.js";
import type { TaskSpec, TaskRecord as DomainTaskRecord } from "../domain/types.js";
import type { OrchestratorService } from "./runner.js";
import type { Persistence } from "../persistence/container.js";

/** What a control call reports back. */
export interface WorkerOutcome {
  ok: boolean;
  /** Machine-readable reason when `ok` is false. */
  reason?: "busy" | "not-found" | "terminal" | "no-worker" | "interrupt-not-supported";
  message: string;
  /** Status after the call, when the worker changed it. */
  status?: string;
}

export interface StartOptions {
  spec: TaskSpec;
  /** Label recorded on the run row (e.g. "dashboard"). */
  reason?: string;
  /**
   * Called once the run reaches a terminal state.
   *
   * The argument is the orchestrator's own in-memory record (`domain/types`),
   * which is a different shape from the persisted task row. Callers that want
   * the stored row should re-read it.
   */
  onFinished?(record: DomainTaskRecord): void | Promise<void>;
}

export interface TaskWorker {
  /** Executes the task. Rejects a second concurrent start for the same task. */
  start(taskId: string, options: StartOptions): Promise<WorkerOutcome>;
  /** Requests a cooperative pause. */
  pause(taskId: string, options?: { reason?: string; actor?: string }): Promise<WorkerOutcome>;
  /** Requests a cooperative cancel. */
  cancel(taskId: string, options?: { reason?: string; actor?: string }): Promise<WorkerOutcome>;
  /** True while this worker holds a live run for the task. */
  isBusy(taskId: string): boolean;
  /** Task ids this worker is currently running. */
  busyTasks(): string[];
  /** Stops everything (process shutdown). */
  shutdown(): Promise<void>;
}

export interface SingleProcessWorkerOptions {
  persistence: Persistence;
  orchestrator: OrchestratorService;
  logger: Logger;
  /**
   * How often the run reports liveness. Also the resolution of stale detection:
   * a task whose heartbeat is older than `staleThresholdMs` is considered
   * abandoned.
   */
  heartbeatIntervalMs?: number;
  /** Consulted to decide whether a task is paused (defence in depth). */
  checkInterrupt?: (taskId: string) => Promise<{ intent: InterruptIntent; reason: string } | undefined>;
  /**
   * Builds the per-run interrupt watcher.
   *
   * The watcher answers "did a human ask to stop?" from a short-lived cache, so
   * the orchestrator's synchronous safe-point check never blocks on the database.
   * A factory (rather than one shared instance) keeps each concurrent run's answer
   * independent.
   */
  interruptWatcherFor?(internalTaskId: string): InterruptSignals;
}

/**
 * Runs tasks in this process, one run at a time, with cooperative interrupts.
 */
export class SingleProcessWorker implements TaskWorker {
  private readonly persistence: Persistence;
  private readonly orchestrator: OrchestratorService;
  private readonly logger: Logger;
  private readonly heartbeatIntervalMs: number;
  private readonly checkInterrupt: NonNullable<SingleProcessWorkerOptions["checkInterrupt"]>;
  private readonly interruptWatcherFor?: SingleProcessWorkerOptions["interruptWatcherFor"];

  /** Tasks this instance is running, with their cancellation plumbing. */
  private readonly running = new Map<
    string,
    { startedAt: number; abort: AbortController; done: Promise<void> }
  >();

  constructor(options: SingleProcessWorkerOptions) {
    this.persistence = options.persistence;
    this.orchestrator = options.orchestrator;
    this.logger = options.logger;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.checkInterrupt = options.checkInterrupt ?? (async () => undefined);
    this.interruptWatcherFor = options.interruptWatcherFor;
  }

  isBusy(taskId: string): boolean {
    return this.running.has(taskId);
  }

  busyTasks(): string[] {
    return [...this.running.keys()];
  }

  async start(taskId: string, options: StartOptions): Promise<WorkerOutcome> {
    const tasks = this.persistence.repositories.tasks;
    const task = await tasks.findByExternalId(taskId);
    if (!task) return { ok: false, reason: "not-found", message: `No task ${taskId}` };

    // Concurrency guard. `claim` is the database-side compare-and-set, so this
    // refuses a second start even across processes — a local flag would not.
    if (this.isBusy(task.externalId)) {
      return {
        ok: false,
        reason: "busy",
        message: `Task ${task.externalId} is already running in this worker`,
        status: task.status,
      };
    }

    const claim = await tasks.claim({
      taskId: task.id,
      eventId: `worker-claim:${task.externalId}:${Date.now()}`,
      cycle: 1,
    });

    if (!claim.claimed) {
      const reason = claim.reason === "terminal" ? "terminal" : "busy";
      return {
        ok: false,
        reason,
        message:
          claim.reason === "terminal"
            ? `Task ${task.externalId} is ${claim.task?.status ?? "terminal"} and cannot be started`
            : `Task ${task.externalId} is already claimed (${claim.task?.status ?? "in flight"})`,
        ...(claim.task ? { status: claim.task.status } : {}),
      };
    }

    const abort = new AbortController();
    const done = this.execute(task.externalId, options, abort.signal).finally(() => {
      this.running.delete(task.externalId);
    });
    // Recorded before returning so a concurrent start sees it immediately.
    this.running.set(task.externalId, { startedAt: Date.now(), abort, done });

    return { ok: true, message: `Task ${task.externalId} started`, status: "CODING" };
  }

  async pause(taskId: string, options: { reason?: string; actor?: string } = {}): Promise<WorkerOutcome> {
    return this.requestInterrupt(taskId, "pause", options.reason ?? "paused by the project owner", options.actor);
  }

  async cancel(taskId: string, options: { reason?: string; actor?: string } = {}): Promise<WorkerOutcome> {
    return this.requestInterrupt(taskId, "cancel", options.reason ?? "cancelled by the project owner", options.actor);
  }

  /**
   * Records the interrupt durably and, when the run belongs to this process,
   * aborts its in-flight network call so the unwind happens promptly instead of
   * after the current model/tool call finishes.
   *
   * The status change itself is performed by the run's own unwind path, so the
   * database never claims PAUSED while the work continues.
   */
  private async requestInterrupt(
    taskId: string,
    intent: InterruptIntent,
    reason: string,
    actor?: string,
  ): Promise<WorkerOutcome> {
    const task = await this.persistence.repositories.tasks.findByExternalId(taskId);
    if (!task) return { ok: false, reason: "not-found", message: `No task ${taskId}` };

    await this.persistence.repositories.interrupts.request({
      taskId: task.id,
      intent,
      reason,
      ...(actor ? { actor } : {}),
    });

    const live = this.running.get(task.externalId);
    if (live) {
      // Abort cooperative work: the run checks the signal between turns/tools.
      live.abort.abort(intent);
      this.logger.info("worker.interrupt_signalled", { taskId: task.externalId, intent, reason });
      return {
        ok: true,
        message: `${intent} requested; the run will stop at its next safe point`,
        status: task.status,
      };
    }

    // No run in this process: something else owns it (or it is stale). Report
    // that honestly rather than pretending a pause took effect.
    return {
      ok: false,
      reason: "no-worker",
      message: `No active run for ${task.externalId} in this process; the request was recorded and will be honoured if a worker picks it up`,
      status: task.status,
    };
  }

  /** The actual run, with heartbeat, interrupt handling and agent recovery. */
  private async execute(externalId: string, options: StartOptions, signal: AbortSignal): Promise<void> {
    const repos = this.persistence.repositories;
    const tasks = repos.tasks;
    const agentIds = this.persistence.agentIds;
    const task = await tasks.findByExternalId(externalId);
    if (!task) return;

    const log = this.logger.child({ taskId: externalId, worker: "single-process" });
    const startedAt = Date.now();

    // Each run gets its own interrupt watcher: two concurrent tasks must never
    // share one answer.
    const watcher = this.interruptWatcherFor?.(task.id);

    // Liveness: while the run is in flight the task's heartbeat is refreshed, so
    // stale detection can tell "long run" from "dead process".
    const heartbeat = setInterval(() => {
      void tasks.heartbeat(task.id).catch(() => {});
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();
    await tasks.heartbeat(task.id).catch(() => {});

    // A recorded interrupt also has to be observed even when the abort signal was
    // missed (the request may have been made from another process).
    const local = new AbortController();
    signal.addEventListener("abort", () => local.abort(signal.reason), { once: true });

    // Keep the watcher warm AND watch for an interrupt recorded by someone else.
    // Without this refresh the orchestrator's synchronous cache read would always
    // see a stale (empty) value and the pause would never take effect.
    const pending = setInterval(() => {
      void watcher
        ?.refresh()
        .then(() => {
          const request = watcher.pull();
          if (request) {
            console.log(`[WORKER] setInterval pulled request:`, request.intent);
            local.abort(request.intent);
          }
        })
        .catch(() => {});
    }, 500);
    pending.unref?.();

    try {
      const record = await this.orchestrator.run(options.spec, {
        checkInterrupt: () => {
          const request = watcher?.pull();
          if (request) console.log(`[WORKER] checkInterrupt returning request:`, request.intent);
          if (!request) return undefined;
          return {
            intent: request.intent,
            reason: request.reason,
            ...(request.actor ? { actor: request.actor } : {}),
          };
        },
      });
      log.info("worker.run_finished", { state: record.state, durationMs: Date.now() - startedAt });
      await options.onFinished?.(record);
    } catch (error) {
      // A human interrupt is a deliberate stop, not a crash: the task takes the
      // status the human asked for and the agents are released.
      if (isTaskInterrupt(error)) {
        console.log(`[WORKER] Caught TaskInterruptError in execute!`, error.request.intent);
        const { intent, reason } = error.request;
        const target = intent === "cancel" ? "CANCELLED" : "PAUSED";
        const from = (await tasks.findByExternalId(externalId))?.status;

        log.info("worker.run_interrupted", { intent, reason, target });

        await tasks.setStatus(task.id, target, {
          ...(from ? { fromStatus: from } : {}),
          transitionSeqBump: true,
          ...(target === "CANCELLED" ? { clearApproval: true, clearCompletion: true } : {}),
        });
        // The request has been honoured; clear it so a resume is not immediately
        // interrupted again.
        await repos.interrupts.clear(task.id).catch(() => {});
        await this.releaseAgents(agentIds, task.id);
        return;
      }

      // Crash path: the task must not look DONE, and the agents must not stay
      // WORKING/REVIEWING forever.
      const message = error instanceof Error ? error.message : String(error);
      log.error("worker.run_failed", { error: message });

      const from = (await tasks.findByExternalId(externalId))?.status;
      await tasks
        .setStatus(task.id, "NEEDS_HUMAN", {
          ...(from ? { fromStatus: from } : {}),
          transitionSeqBump: true,
        })
        .catch(() => {});
      await this.releaseAgents(agentIds, task.id, "ERROR");
    } finally {
      clearInterval(heartbeat);
      clearInterval(pending);
    }
  }

  /** Puts agents back to IDLE (normal stop) or ERROR (crash) when a run ends. */
  private async releaseAgents(
    agentIds: { coder?: string; reviewer?: string },
    currentTaskId: string,
    status: "IDLE" | "ERROR" = "IDLE",
  ): Promise<void> {
    for (const agentId of [agentIds.coder, agentIds.reviewer]) {
      if (!agentId) continue;
      const agent = await this.persistence.repositories.agents.findById(agentId).catch(() => undefined);
      if (!agent) continue;
      // Only release an agent that is still holding THIS task: an agent working
      // on something else must not be disturbed.
      if (agent.currentTaskId && agent.currentTaskId !== currentTaskId) continue;
      await this.persistence.repositories.agents
        .setStatus(agentId, status, { currentTaskId: null })
        .catch(() => {});
    }
  }

  async shutdown(): Promise<void> {
    const running = [...this.running.values()];
    for (const entry of running) entry.abort.abort("shutdown");
    await Promise.allSettled(running.map((entry) => entry.done));
    this.running.clear();
  }
}
