/**
 * Internal event bus.
 *
 * `publish` resolves once the event has been fanned out to subscribers.
 *
 * Failure policy (explicit, because event publishing must never be the reason a
 * task silently looks successful):
 *   - a *subscriber* failure is isolated: one broken sink does not stop the
 *     others, and it is reported through `onError` rather than thrown;
 *   - a *transport* failure is reported to the caller via `onError` and recorded
 *     in `stats().failures`, but does not abort the pipeline by default.
 *
 * The orchestrator decides what a failure means; the bus does not hide it.
 */

import { isTerminalEvent, type AnyTaskEvent, type TaskEvent, type TaskEventType } from "./types.js";

export interface EventTransport {
  /** Stable name used in logs. */
  readonly name: string;
  publish(event: AnyTaskEvent): Promise<void>;
  /** Optional teardown for transports holding sockets/connections. */
  close?(): Promise<void>;
}

export type EventListener = (event: AnyTaskEvent) => void | Promise<void>;

export interface BusError {
  stage: "transport" | "listener";
  source: string;
  event: AnyTaskEvent;
  error: Error;
}

export interface EventBusOptions {
  /** Failures are surfaced here instead of being swallowed. */
  onError?: (failure: BusError) => void;
  /** Keep a rolling in-memory copy of recent events (dashboard/late joiners). */
  replayBufferSize?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Injectable id generator for deterministic tests. */
  newId?: () => string;
}

export interface EventBusStats {
  published: number;
  delivered: number;
  failures: number;
  duplicateSubscriberDeliveries: number;
}

export interface EventBus {
  readonly name: string;
  publish(event: AnyTaskEvent): Promise<void>;
  subscribe(listener: EventListener): () => void;
  addTransport(transport: EventTransport): void;
  removeTransport(name: string): boolean;
  /**
   * Names of the transports currently attached, in registration order.
   *
   * This is the supported way to discover what the bus is fanning out to (the
   * dashboard reports it as the realtime transport list). Callers previously
   * reached for a `transports` property that does not exist, so the list always
   * came back empty.
   */
  transportNames(): string[];
  /** Recent events, oldest first. */
  recent(limit?: number): AnyTaskEvent[];
  /** Filtered replay, for a dashboard that just joined. */
  recentOfType(types: readonly TaskEventType[], limit?: number): AnyTaskEvent[];
  waitFor(
    predicate: (event: AnyTaskEvent) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<AnyTaskEvent>;
  stats(): EventBusStats;
  close(): Promise<void>;
}

/** Default factory used when a caller does not supply one (tests inject theirs). */
export function defaultEventId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const transports: EventTransport[] = [];
  const listeners = new Set<EventListener>();
  const replay: AnyTaskEvent[] = [];
  const waiters: Array<{
    predicate: (event: AnyTaskEvent) => boolean;
    resolve: (event: AnyTaskEvent) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
  }> = [];
  const replayBufferSize = options.replayBufferSize ?? 500;
  const stats: EventBusStats = {
    published: 0,
    delivered: 0,
    failures: 0,
    duplicateSubscriberDeliveries: 0,
  };

  const reportError = (failure: BusError): void => {
    stats.failures += 1;
    if (options.onError) {
      options.onError(failure);
      return;
    }
    // Last resort so a failure is never invisible.
    process.stderr.write(
      `[event-bus] ${failure.stage} failure from ${failure.source} on ${failure.event.type}: ${failure.error.message}\n`,
    );
  };

  const toError = (value: unknown): Error =>
    value instanceof Error ? value : new Error(String(value));

  const notifyWaiters = (event: AnyTaskEvent): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      let matched = false;
      try {
        matched = waiter.predicate(event);
      } catch (error) {
        waiter.reject(toError(error));
        if (waiter.timer) clearTimeout(waiter.timer);
        waiters.splice(i, 1);
        continue;
      }
      if (matched) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  };

  return {
    name: "event-bus",

    async publish(event: AnyTaskEvent): Promise<void> {
      stats.published += 1;

      // Listeners are awaited one at a time, in order. That sequentiality is what
      // gives the journal a deterministic write order: `activity_logs.publish_seq`
      // is assigned by the database at insert time, so a replay follows exactly
      // the publish order even when several events share a millisecond.
      //
      // 1. Local subscribers (in-process consumers such as the recorder).
      //    A failing listener must not prevent the transports from receiving it.
      for (const listener of [...listeners]) {
        try {
          await listener(event);
          stats.delivered += 1;
        } catch (error) {
          reportError({
            stage: "listener",
            source: "subscribe()",
            event,
            error: toError(error),
          });
        }
      }

      // 2. Transports (realtime fan-out). All get the event even if one fails.
      await Promise.all(
        transports.map(async (transport) => {
          try {
            await transport.publish(event);
            stats.delivered += 1;
          } catch (error) {
            reportError({
              stage: "transport",
              source: transport.name,
              event,
              error: toError(error),
            });
          }
        }),
      );

      // 3. Replay buffer, bounded.
      replay.push(event);
      if (replay.length > replayBufferSize) replay.splice(0, replay.length - replayBufferSize);

      notifyWaiters(event);
    },

    subscribe(listener: EventListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    addTransport(transport: EventTransport): void {
      if (transports.some((existing) => existing.name === transport.name)) return;
      transports.push(transport);
    },

    removeTransport(name: string): boolean {
      const index = transports.findIndex((transport) => transport.name === name);
      if (index < 0) return false;
      transports.splice(index, 1);
      return true;
    },

    transportNames(): string[] {
      // A copy, so a caller iterating it cannot mutate the bus's own registry.
      return transports.map((transport) => transport.name);
    },

    recent(limit = 100): AnyTaskEvent[] {
      return replay.slice(Math.max(0, replay.length - limit));
    },

    recentOfType(types, limit = 100): AnyTaskEvent[] {
      const wanted = new Set<TaskEventType>(types);
      return replay.filter((event) => wanted.has(event.type)).slice(-limit);
    },

    waitFor(predicate, waitOptions = {}): Promise<AnyTaskEvent> {
      const existing = replay.find((event) => predicate(event));
      if (existing) return Promise.resolve(existing);

      const timeoutMs = waitOptions.timeoutMs ?? 30_000;
      return new Promise<AnyTaskEvent>((resolve, reject) => {
        const waiter = { predicate, resolve, reject } as (typeof waiters)[number];
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for an event`));
        }, timeoutMs);
        // Do not keep the process alive just for a test waiter.
        waiter.timer.unref?.();
        waiters.push(waiter);
      });
    },

    stats: () => ({ ...stats }),

    async close(): Promise<void> {
      for (const waiter of waiters.splice(0)) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new Error("event bus closed"));
      }
      listeners.clear();
      for (const transport of transports.splice(0)) {
        try {
          await transport.close?.();
        } catch {
          // Teardown failures are not actionable.
        }
      }
    },
  };
}

/** Builds a well-formed event. Centralised so ids/timestamps are consistent. */
export function makeEvent<K extends TaskEventType>(params: {
  type: K;
  taskId: string;
  payload: TaskEvent<K>["payload"];
  agentId?: string;
  cycle?: number;
  id?: string;
  timestamp?: string;
  now?: () => Date;
  newId?: () => string;
}): TaskEvent<K> {
  return {
    id: params.id ?? (params.newId ?? defaultEventId)(),
    type: params.type,
    taskId: params.taskId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.cycle === undefined ? {} : { cycle: params.cycle }),
    timestamp: params.timestamp ?? (params.now ?? (() => new Date()))().toISOString(),
    payload: params.payload,
  };
}

export { isTerminalEvent };
