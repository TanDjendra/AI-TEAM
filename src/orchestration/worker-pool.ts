/**
 * WorkerPool — concurrency-limited async dispatcher for workflow nodes (Phase V2-08).
 *
 * Architecture: a single supervisor timer fires every `pollIntervalMs`. Each
 * tick it computes how many lanes are free (`poolSize - activeCount`) and
 * sequentially attempts claims to fill those slots. Each successful claim
 * launches a fire-and-forget "lane" whose lifetime is tracked by the pool.
 *
 * This avoids the "thundering herd" problem: there is one timer, not N. The
 * database handles contention via FOR UPDATE SKIP LOCKED — no application-level
 * retries or back-off needed.
 *
 * Design constraints (V2-08 blueprint):
 *   - No Redis, RabbitMQ, or external message brokers.
 *   - Polling and locking are strictly native to PostgreSQL/PGlite.
 *   - Does NOT modify the core V1 FSM or Task Runner logic.
 */

import type { Logger } from "../domain/logger.js";

export interface WorkerPoolOptions {
  /** Maximum concurrent lanes (default 4, clamped to 1–16). */
  poolSize: number;
  /**
   * Attempts to claim one unit of work.
   *
   * Contract:
   *  - Returns `null` if no work was available (fast — just a DB query).
   *  - Returns a `Promise<void>` (the "lane lifetime") if work was claimed
   *    and dispatched. That promise resolves when the dispatched task finishes.
   *
   * The outer promise resolves quickly (claim + dispatch). The returned inner
   * promise represents the full lifecycle of the dispatched work — the pool
   * holds it in `activeLanes` so `stop()` can drain gracefully.
   */
  tryClaimWork: () => Promise<{ laneLifetime: Promise<void> } | null>;
  /** Milliseconds between supervisor ticks when no work was found. */
  pollIntervalMs: number;
  logger: Logger;
}

export class WorkerPool {
  private readonly poolSize: number;
  private readonly tryClaimWork: () => Promise<{ laneLifetime: Promise<void> } | null>;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;

  /** Currently executing lanes. Each resolves when its task finishes. */
  private readonly activeLanes = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private isStopping = false;
  private activePolling = false;

  constructor(options: WorkerPoolOptions) {
    this.poolSize = Math.max(1, Math.min(16, options.poolSize));
    this.tryClaimWork = options.tryClaimWork;
    this.pollIntervalMs = Math.max(500, options.pollIntervalMs);
    this.logger = options.logger.child({ service: "worker-pool" });
  }

  /** Number of lanes currently executing work. */
  get activeCount(): number {
    return this.activeLanes.size;
  }

  /** Remaining capacity. */
  get capacity(): number {
    return this.poolSize - this.activeLanes.size;
  }

  /**
   * Starts the supervisor loop. Idempotent — a second call is a no-op.
   * The first tick fires immediately (delay = 0).
   */
  start(): void {
    if (this.timer || this.isStopping) return;
    this.logger.info("pool.started", {
      poolSize: this.poolSize,
      pollIntervalMs: this.pollIntervalMs,
    });
    this.scheduleNextTick(0);
  }

  /**
   * Stops accepting new work and waits for all active lanes to drain.
   * Matches V1's cooperative shutdown: no tasks are aborted.
   */
  async stop(): Promise<void> {
    this.isStopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const pending = [...this.activeLanes];
    if (pending.length > 0) {
      this.logger.info("pool.draining", { activeLanes: pending.length });
      await Promise.allSettled(pending);
    }

    this.activeLanes.clear();
    this.logger.info("pool.stopped", { message: "All lanes drained." });
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private scheduleNextTick(delayMs: number = this.pollIntervalMs): void {
    if (this.isStopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
  }

  /**
   * One supervisor tick:
   *  1. Compute how many slots are free.
   *  2. Sequentially attempt claims to fill those slots.
   *     (Sequential so we stop as soon as the DB reports "no work".)
   *  3. Each successful claim creates a fire-and-forget lane tracked in activeLanes.
   *  4. If any work was found, tick again immediately to saturate the pool.
   */
  private async tick(): Promise<void> {
    if (this.isStopping || this.activePolling) return;
    this.activePolling = true;

    let anyWorkFound = false;

    try {
      let slotsAvailable = this.poolSize - this.activeLanes.size;

      while (slotsAvailable > 0 && !this.isStopping) {
        try {
          const claimResult = await this.tryClaimWork();

          if (!claimResult) {
            // No more work available — stop trying this tick.
            break;
          }

          const { laneLifetime } = claimResult;

          anyWorkFound = true;
          slotsAvailable--;

          // Track the lane. It will self-remove when the task finishes.
          const lane: Promise<void> = laneLifetime;
          this.activeLanes.add(lane);
          lane
            .catch((error: unknown) => {
              this.logger.error("pool.lane_failed", {
                error: error instanceof Error ? error.message : String(error),
              });
            })
            .finally(() => {
              this.activeLanes.delete(lane);
              void this.tick();
            });
        } catch (error) {
          this.logger.error("pool.claim_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
    } catch (error) {
      this.logger.error("pool.tick_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activePolling = false;
      // If work was found, tick again immediately to fill remaining capacity.
      // Otherwise, sleep for the poll interval.
      this.scheduleNextTick(anyWorkFound ? 0 : this.pollIntervalMs);
    }
  }
}
