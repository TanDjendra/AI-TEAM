/**
 * Automatic Stale-Run Sweeper (PHASE 7B).
 *
 * Runs periodically in the background to detect abandoned runs (where the worker
 * process died before it could release the task) and recover them according to
 * the system's policy, without human intervention.
 */

import type { Logger } from "../domain/logger.js";
import type { RecoveryPolicy, RecoveryService } from "./recovery.js";

export interface StaleSweeperOptions {
  recovery: RecoveryService;
  logger: Logger;
  /** How often the sweep runs in milliseconds. */
  intervalMs: number;
  /** Policy applied to discovered stale runs. */
  policy?: RecoveryPolicy;
}

export class StaleSweeper {
  private readonly recovery: RecoveryService;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly policy: RecoveryPolicy;
  private timer?: ReturnType<typeof setInterval>;
  private isSweeping = false;

  constructor(options: StaleSweeperOptions) {
    this.recovery = options.recovery;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs;
    // By default, automatically interrupt the run and set the task to NEEDS_HUMAN.
    this.policy = options.policy ?? {
      markRunsInterrupted: true,
      releaseAgents: true,
      staleTaskStatus: "NEEDS_HUMAN",
    };
  }

  start(): void {
    if (this.timer) return;
    this.logger.info("sweeper.started", { intervalMs: this.intervalMs });
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    // Do an immediate initial sweep.
    void this.sweep();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger.info("sweeper.stopped", {});
    }
  }

  /** Performs a single sweep explicitly and awaits its completion. */
  async sweepOnce(): Promise<void> {
    return this.sweep();
  }

  private async sweep(): Promise<void> {
    if (this.isSweeping) return;
    this.isSweeping = true;
    try {
      const report = await this.recovery.recover(this.policy);
      if (report.applied.length > 0) {
        this.logger.warn("sweeper.recovered", {
          staleCount: report.applied.length,
          taskIds: report.applied.map((a) => a.taskExternalId),
        });
      }
    } catch (error) {
      this.logger.error("sweeper.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.isSweeping = false;
    }
  }
}
