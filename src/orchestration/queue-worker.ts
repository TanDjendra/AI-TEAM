import type { Logger } from "../domain/logger.js";
import type { Persistence } from "../persistence/container.js";
import type { TaskWorker } from "./worker.js";

import { basename } from "node:path";

export interface QueueWorkerOptions {
  persistence: Persistence;
  logger: Logger;
  worker: TaskWorker;
  concurrency: number;
  pollIntervalMs: number;
}

export class QueueWorker {
  private readonly persistence: Persistence;
  private readonly logger: Logger;
  private readonly worker: TaskWorker;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;

  private timer?: ReturnType<typeof setTimeout>;
  private isStopping = false;
  private activePolling = false;

  constructor(options: QueueWorkerOptions) {
    this.persistence = options.persistence;
    this.logger = options.logger;
    this.worker = options.worker;
    this.concurrency = Math.max(1, options.concurrency);
    this.pollIntervalMs = Math.max(1000, options.pollIntervalMs);
  }

  start(): void {
    if (this.timer || this.isStopping) return;
    this.logger.info("queue.started", { concurrency: this.concurrency, pollIntervalMs: this.pollIntervalMs });
    this.scheduleNextPoll();
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    
    this.logger.info("queue.stopping", { message: "Waiting for active runs to finish or pause..." });
    await this.worker.shutdown();
    this.logger.info("queue.stopped", { message: "All active runs stopped." });
  }

  private scheduleNextPoll(delayMs: number = this.pollIntervalMs): void {
    if (this.isStopping) return;
    this.timer = setTimeout(() => {
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.isStopping || this.activePolling) return;
    
    this.activePolling = true;
    let foundWork = false;

    try {
      const busyCount = this.worker.busyTasks().length;
      const capacity = this.concurrency - busyCount;

      if (capacity > 0) {
        // Find PENDING tasks
        const pendingTasks = await this.persistence.repositories.tasks.list({
          status: ["PENDING"],
          limit: capacity,
        });

        for (const task of pendingTasks) {
          if (this.isStopping) break;
          
          this.logger.info("queue.claiming", { taskId: task.externalId });
          const outcome = await this.worker.start(task.externalId, {
            spec: {
              id: task.externalId,
              title: task.title,
              description: task.description,
              workspaceSlug: basename(task.workspace),
            },
            reason: "queue_worker_claim",
          });

          if (outcome.ok) {
            foundWork = true;
            this.logger.info("queue.claimed", { taskId: task.externalId });
          } else {
            this.logger.info("queue.claim_failed", { taskId: task.externalId, reason: outcome.reason });
          }
        }
      }
    } catch (error) {
      this.logger.error("queue.poll_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activePolling = false;
      // If we found work, poll again immediately to fill remaining capacity (if any).
      // Otherwise, wait for the poll interval.
      this.scheduleNextPoll(foundWork ? 0 : this.pollIntervalMs);
    }
  }
}
