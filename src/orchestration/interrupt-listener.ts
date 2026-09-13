/**
 * Cooperative-interrupt listener.
 *
 * The worker asks "did a human ask me to stop?" at safe points only. The check is
 * cheap and cached: the database is polled at `refreshMs`, and every call
 * in between answers from that cache. A synchronous getter then hands the request
 * to the orchestration loop without it needing to know about persistence.
 *
 * Two signals are supported, and both come from the same record:
 *   - `signal`  — an AbortSignal the provider uses to cancel an in-flight HTTP
 *                 call, so a pause does not have to wait for a slow model.
 *   - `pull()`  — a synchronous check used at turn/tool boundaries.
 */

import type { InterruptIntent, InterruptRequest } from "../domain/control.js";
import type { InterruptRepository } from "../persistence/repositories/interrupt-repository.js";

export interface InterruptSignals {
  /** Synchronous check, safe to call at a safe point. */
  pull(): InterruptRequest | undefined;
  /** Forces a refresh from the database (used after recording a request). */
  refresh(): Promise<void>;
}

export interface InterruptWatcherOptions {
  interrupts: InterruptRepository;
  /** Internal task id (uuid). */
  taskId: string;
  /** How long a cached answer is reused. */
  refreshMs?: number;
  now?: () => number;
}

export function createInterruptWatcher(options: InterruptWatcherOptions): InterruptSignals {
  const refreshMs = options.refreshMs ?? 1_000;
  const now = options.now ?? (() => Date.now());

  let cached: InterruptRequest | undefined;
  let checkedAt = 0;
  let inFlight: Promise<void> | undefined;

  const load = async (): Promise<void> => {
    try {
      const pending = await options.interrupts.pending(options.taskId);
      cached = pending
        ? {
            intent: pending.intent as InterruptIntent,
            reason: pending.reason,
            actor: pending.actor,
            requestedAt: pending.requestedAt,
          }
        : undefined;
    } catch {
      // A read failure must not fabricate an interrupt; keep the last answer.
    } finally {
      checkedAt = now();
    }
  };

  const refresh = async (): Promise<void> => {
    inFlight ??= load().finally(() => {
      inFlight = undefined;
    });
    await inFlight;
  };

  return {
    /**
     * Answers from cache when fresh. It deliberately does NOT trigger a database
     * read on the hot path: a safe point must never block the run.
     */
    pull(): InterruptRequest | undefined {
      if (now() - checkedAt > refreshMs) void refresh();
      return cached;
    },
    refresh,
  };
}

export type { InterruptRequest, InterruptIntent };
