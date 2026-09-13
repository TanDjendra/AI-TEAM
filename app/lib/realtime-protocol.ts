/**
 * Realtime protocol — pure functions, no React and no DOM.
 *
 * The hook in `use-event-stream.ts` owns the EventSource; everything that can be
 * reasoned about (message parsing, dedupe, buffer bounds, connection state) lives
 * here so it is directly testable — including the requirement that the UI stays
 * usable when realtime never connects.
 */

import type { AnyTaskEvent } from "../../src/events/types.js";

export type ConnectionState = "CONNECTED" | "RECONNECTING" | "DISCONNECTED";

export interface StreamHello {
  kind: "hello";
  configured?: boolean;
  error?: string;
  transports?: string[];
  serverTime?: string;
}

export interface StreamEvent {
  kind: "event";
  event: AnyTaskEvent;
}

export interface StreamBacklogComplete {
  kind: "backlog-complete";
}

export type StreamMessage = StreamHello | StreamEvent | StreamBacklogComplete;

export interface RealtimeEntry {
  key: string;
  event: AnyTaskEvent;
  receivedAt: number;
}

export interface FeedState {
  entries: RealtimeEntry[];
  seen: ReadonlySet<string>;
  ready: boolean;
  state: ConnectionState;
  error?: string;
  transports: string[];
}

export function initialFeedState(): FeedState {
  return { entries: [], seen: new Set(), ready: false, state: "RECONNECTING", transports: [] };
}

/** Parses one SSE `data:` payload. Returns undefined for anything unusable. */
export function parseStreamMessage(raw: string): StreamMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;

  const candidate = parsed as Partial<StreamMessage> & { kind?: unknown };
  if (candidate.kind === "hello") return candidate as StreamHello;
  if (candidate.kind === "backlog-complete") return candidate as StreamBacklogComplete;
  if (candidate.kind === "event") {
    const event = (candidate as StreamEvent).event;
    // An event without an id cannot be deduped; drop it rather than render a
    // duplicate on every reconnect.
    if (!event || typeof event.id !== "string") return undefined;
    return candidate as StreamEvent;
  }
  return undefined;
}

/** Keeps the dedupe set from growing without bound in a long-lived tab. */
const SEEN_LIMIT = 5_000;

function insertEntry(state: FeedState, entry: RealtimeEntry, limit: number): FeedState {
  const entries = [entry, ...state.entries];
  return { ...state, entries: entries.length > limit ? entries.slice(0, limit) : entries };
}

export interface ReduceOptions {
  limit?: number;
  now?: number;
}

/**
 * Applies one decoded message to the feed.
 *
 * Ordering: the server sends the backlog in ascending order and each live event
 * as it happens, so the feed is newest-first by insertion. Duplicate ids (a
 * reconnect replays the backlog) are ignored.
 */
export function reduceStreamMessage(
  state: FeedState,
  message: StreamMessage,
  options: ReduceOptions = {},
): FeedState {
  const limit = options.limit ?? 200;
  const now = options.now ?? Date.now();

  switch (message.kind) {
    case "hello": {
      if (message.configured === false) {
        // No database: there is no stream to maintain. The UI falls back to the
        // REST endpoints, which continue to serve historical data.
        return {
          ...state,
          state: "DISCONNECTED",
          ready: false,
          error: message.error ?? "Database is not configured",
          transports: message.transports ?? state.transports,
        };
      }
      return { ...state, transports: message.transports ?? state.transports };
    }

    case "backlog-complete":
      return { ...state, ready: true, state: "CONNECTED", error: undefined, transports: state.transports };

    case "event": {
      if (state.seen.has(message.event.id)) return state;
      const seen = new Set(state.seen);
      seen.add(message.event.id);
      const trimmed = seen.size > SEEN_LIMIT ? new Set([...seen].slice(-2_000)) : seen;
      return insertEntry({ ...state, seen: trimmed }, {
        key: message.event.id,
        event: message.event,
        receivedAt: now,
      }, limit);
    }
  }
}

/** State after the transport drops; historical data must remain on screen. */
export function markDisconnected(state: FeedState, error?: string): FeedState {
  return { ...state, ready: false, state: "RECONNECTING", ...(error ? { error } : {}) };
}

/** Backoff schedule for reconnects, capped. */
export function reconnectDelayMs(failures: number, maxMs = 10_000): number {
  const attempt = Math.max(1, failures);
  return Math.min(1_000 * 2 ** (attempt - 1), maxMs);
}
