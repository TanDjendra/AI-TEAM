"use client";

/**
 * Realtime connection to the dashboard event stream.
 *
 * States map directly to what the operator needs to know:
 *   CONNECTED    — stream is open and its backlog has arrived
 *   RECONNECTING — stream dropped or never opened; retrying with backoff
 *   DISCONNECTED — no database configured, so there is nothing to stream
 *
 * When the stream is down the rest of the UI still works: every panel loads from
 * the database over REST. The stream is an enhancement, never a hard dependency.
 * All reasoning lives in `realtime-protocol.ts` so it is unit-testable.
 */

import * as React from "react";

import {
  initialFeedState,
  markDisconnected,
  parseStreamMessage,
  reconnectDelayMs,
  reduceStreamMessage,
  type FeedState,
} from "./realtime-protocol.js";

export type { ConnectionState, RealtimeEntry } from "./realtime-protocol.js";

export interface UseEventStreamOptions {
  /** Buffer size for the live feed. */
  limit?: number;
  url?: string;
}

export interface EventStreamResult {
  state: FeedState["state"];
  ready: boolean;
  entries: FeedState["entries"];
  error?: string;
  transports: string[];
  reconnect: () => void;
}

const MAX_BACKOFF_MS = 10_000;

export function useEventStream(options: UseEventStreamOptions = {}): EventStreamResult {
  const limit = options.limit ?? 200;
  const url = options.url ?? "/api/events";

  const [feed, setFeed] = React.useState<FeedState>(initialFeedState);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    // EventSource is browser-only and genuinely absent during SSR.
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let failures = 0;

    const open = (): void => {
      if (closed) return;
      source = new EventSource(url);

      source.onopen = () => {
        failures = 0;
      };

      source.onmessage = (message: MessageEvent<string>) => {
        const decoded = parseStreamMessage(message.data);
        if (!decoded) return;

        if (decoded.kind === "hello" && decoded.configured === false) {
          closed = true;
          source?.close();
        }

        setFeed((current) => reduceStreamMessage(current, decoded, { limit }));
      };

      source.onerror = () => {
        source?.close();
        if (closed) return;

        failures += 1;
        // The browser retries on its own, but we control the schedule so the
        // displayed state stays honest.
        setFeed((current) => markDisconnected(current));
        retryTimer = setTimeout(open, reconnectDelayMs(failures, MAX_BACKOFF_MS));
      };
    };

    open();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [url, limit, attempt]);

  const reconnect = React.useCallback(() => {
    setFeed(initialFeedState());
    setAttempt((value) => value + 1);
  }, []);

  return {
    state: feed.state,
    ready: feed.ready,
    entries: feed.entries,
    ...(feed.error ? { error: feed.error } : {}),
    transports: feed.transports,
    reconnect,
  };
}
