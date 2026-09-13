/**
 * Test doubles for the control stack.
 *
 * A `ScriptedWorker` implements the real `TaskWorker` contract without a model:
 * `start` performs the same database claim a real worker does, then resolves the
 * run according to the script. That keeps the HTTP tests honest about
 * concurrency and persistence while staying deterministic and fast.
 */

import type {
  StartOptions,
  TaskWorker,
  WorkerOutcome,
} from "../../../src/orchestration/worker.js";
import type { Persistence } from "../../../src/persistence/container.js";

/** How a started run behaves. */
export type WorkerScript =
  | { kind: "immediate"; to: "DONE" | "NEEDS_HUMAN" | "CANCELLED" }
  | { kind: "hold" }
  | { kind: "fail"; message: string };

export interface ScriptedWorkerOptions {
  persistence: Persistence;
  script?: WorkerScript;
  /** Injectable id for deterministic claims. */
  newId?: () => string;
}

export class ScriptedWorker implements TaskWorker {
  private readonly persistence: Persistence;
  private readonly script: WorkerScript;
  private readonly newId: () => string;
  private readonly running = new Set<string>();
  /** Recorded control calls, for assertions. */
  readonly calls: Array<{ kind: "start" | "pause" | "cancel"; taskId: string; reason?: string }> = [];

  /** Flips to make pause/cancel stop working (simulates "no worker owns it"). */
  failInterrupts = false;

  constructor(options: ScriptedWorkerOptions) {
    this.persistence = options.persistence;
    // Default to holding: a stray timer that outlives the test database
    // produces unhandled rejections and makes failures harder to read.
    this.script = options.script ?? { kind: "hold" };
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  }

  isBusy(taskId: string): boolean {
    return this.running.has(taskId);
  }

  busyTasks(): string[] {
    return [...this.running.keys()];
  }

  async start(taskId: string, options: StartOptions): Promise<WorkerOutcome> {
    this.calls.push({ kind: "start", taskId, ...(options.reason ? { reason: options.reason } : {}) });

    const tasks = this.persistence.repositories.tasks;
    const task = await tasks.findByExternalId(taskId);
    if (!task) return { ok: false, reason: "not-found", message: `No task ${taskId}` };

    if (this.running.has(task.externalId)) {
      return { ok: false, reason: "busy", message: `Task ${task.externalId} is already running` };
    }

    // The same database claim a real worker performs — this is what makes the
    // double-start test meaningful rather than a mock returning a canned value.
    const claim = await tasks.claim({
      taskId: task.id,
      eventId: `scripted-claim:${task.externalId}:${this.newId()}`,
      cycle: 1,
    });
    if (!claim.claimed) {
      return {
        ok: false,
        reason: claim.reason === "terminal" ? "terminal" : "busy",
        message: `Task ${task.externalId} is ${claim.task?.status ?? "in flight"}`,
        ...(claim.task ? { status: claim.task.status } : {}),
      };
    }

    this.running.add(task.externalId);

    if (this.script.kind === "fail") {
      this.running.delete(task.externalId);
      return { ok: false, reason: "busy", message: this.script.message };
    }

    if (this.script.kind === "immediate") {
      // Resolve on the next tick so the HTTP response can be sent first, exactly
      // like a real detached run.
      setTimeout(() => {
        void this.finish(task.externalId, this.script.kind === "immediate" ? this.script.to : "DONE").catch(
          () => {
            // The run is detached: a failure here (e.g. the database already
            // closed at the end of a test) must not become an unhandled
            // rejection that masks the real assertion failure.
          },
        );
      }, 0);
    }

    return { ok: true, message: `Task ${task.externalId} started`, status: "CODING" };
  }

  private async finish(taskId: string, to: "DONE" | "NEEDS_HUMAN" | "CANCELLED"): Promise<void> {
    const tasks = this.persistence.repositories.tasks;
    const task = await tasks.findByExternalId(taskId);
    this.running.delete(taskId);
    if (!task) return;

    await tasks
      .setStatus(task.id, to, {
        fromStatus: task.status,
        transitionSeqBump: true,
        ...(to === "DONE" ? { clearApproval: false } : {}),
      })
      .catch(() => {});
  }

  async pause(taskId: string, options: { reason?: string } = {}): Promise<WorkerOutcome> {
    this.calls.push({ kind: "pause", taskId, ...(options.reason ? { reason: options.reason } : {}) });
    if (this.failInterrupts || !this.running.has(taskId)) {
      return { ok: false, reason: "no-worker", message: "no active run in this process" };
    }
    const task = await this.persistence.repositories.tasks.findByExternalId(taskId);
    if (!task) return { ok: false, reason: "not-found", message: `No task ${taskId}` };
    return { ok: true, message: "pause requested", status: task.status };
  }

  async cancel(taskId: string, options: { reason?: string } = {}): Promise<WorkerOutcome> {
    this.calls.push({ kind: "cancel", taskId, ...(options.reason ? { reason: options.reason } : {}) });
    if (this.failInterrupts || !this.running.has(taskId)) {
      return { ok: false, reason: "no-worker", message: "no active run in this process" };
    }
    const task = await this.persistence.repositories.tasks.findByExternalId(taskId);
    if (!task) return { ok: false, reason: "not-found", message: `No task ${taskId}` };
    return { ok: true, message: "cancel requested", status: task.status };
  }

  async shutdown(): Promise<void> {
    this.running.clear();
  }
}
