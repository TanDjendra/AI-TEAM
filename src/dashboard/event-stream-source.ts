/**
 * Database-backed event stream.
 *
 * Why this exists: the orchestrator and the dashboard are separate processes.
 * The in-process `EventBus` is exact within one process, but the dashboard never
 * sees an event the orchestrator published — so the live feed would sit silent
 * while real work was happening. Since the database is the source of truth (every
 * bus event is journaled to `activity_logs` with a monotonic `publish_seq`), the
 * stream follows the journal instead: poll for rows past a cursor and push them
 * out.
 *
 * This is deliberately "at least once, in order": the cursor only advances past
 * rows that were handed to the client, and the client dedupes on event id, so a
 * reconnect can replay without duplicating a rendered event.
 */

import type { Persistence } from "../persistence/container.js";
import type { ActivityLogRecord } from "../persistence/repositories/activity-log-repository.js";
import type { AnyTaskEvent } from "../events/types.js";

export const STREAM_BACKLOG = 100;
export const POLL_INTERVAL_MS = 1_500;

export interface PersistedEventStreamOptions {
  persistence: Persistence;
  /**
   * Sequence to start polling after.
   *
   * Pass the highest `publish_seq` already sent to the client as a backlog, so
   * the first poll picks up only genuinely new rows and nothing is skipped or
   * replayed. Defaults to the current maximum.
   */
  startSeq?: number;
  pollIntervalMs?: number;
  /** Called once per poll cycle when new rows were found. */
  onBatch?(events: AnyTaskEvent[]): void;
  onError?(message: string): void;
  /** Injectable timer for tests. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/** Converts a stored journal row back into the event shape the UI consumes. */
export function activityToEvent(record: ActivityLogRecord): AnyTaskEvent {
  return {
    id: record.eventId,
    type: record.eventType,
    taskId: record.taskId ?? record.payload.taskId ?? "",
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.cycle === undefined ? {} : { cycle: record.cycle }),
    timestamp: record.occurredAt,
    payload: { ...record.payload, ...(record.publishSeq ? { publishSeq: record.publishSeq } : {}) },
  } as unknown as AnyTaskEvent;
}

export interface PersistedEventStream {
  /** Latest `publish_seq` delivered to the client. */
  cursor(): number;
  /** Raises the cursor (used after sending a backlog). */
  advanceTo(seq: number): void;
  /** Rows after the cursor; advances the cursor. */
  poll(): Promise<AnyTaskEvent[]>;
  start(): void;
  stop(): void;
  /** Lets the caller push in-process events (same process as the orchestrator). */
  push(event: AnyTaskEvent): void;
}

export async function createPersistedEventStream(
  options: PersistedEventStreamOptions,
): Promise<PersistedEventStream> {
  const { persistence } = options;
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  // Start after whatever the caller already delivered as backlog, or after the
  // current head. A row journaled after this point has a higher sequence, so it
  // is picked up by the next poll rather than lost.
  let cursorValue: number =
    options.startSeq ?? (await persistence.repositories.activityLogs.maxSeq().catch(() => 0));

  let timer: ReturnType<typeof setInterval> | undefined;
  const extra: AnyTaskEvent[] = [];

  const stream: PersistedEventStream = {
    cursor: () => cursorValue,

    advanceTo(seq) {
      if (seq > cursorValue) cursorValue = seq;
    },

    push(event) {
      extra.push(event);
    },

    async poll() {
      const out: AnyTaskEvent[] = [];

      // 1. Anything the local bus delivered since the last tick.
      if (extra.length > 0) out.push(...extra.splice(0, extra.length));

      // 2. Anything another process journaled since the cursor.
      try {
        const rows = await persistence.repositories.activityLogs.listAfterSeq(cursorValue, 200);
        for (const row of rows) {
          if (row.publishSeq > cursorValue) cursorValue = row.publishSeq;
          out.push(activityToEvent(row));
        }
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : String(error));
      }

      if (out.length > 0) options.onBatch?.(out);
      return out;
    },

    start() {
      if (timer) return;
      timer = (options.setIntervalFn ?? setInterval)(() => {
        void stream.poll();
      }, interval);
      // Never keep the process alive just for polling.
      timer.unref?.();
    },

    stop() {
      if (!timer) return;
      (options.clearIntervalFn ?? clearInterval)(timer);
      timer = undefined;
    },
  };

  return stream;
}
