/**
 * Realtime protocol tests.
 *
 * These cover the dashboard's behaviour when the stream is healthy, when it
 * reconnects, and when it never connects at all — the last case is the one that
 * must still leave the UI usable.
 */

import { describe, expect, it } from "vitest";

import {
  initialFeedState,
  markDisconnected,
  parseStreamMessage,
  reconnectDelayMs,
  reduceStreamMessage,
  type StreamMessage,
} from "../../app/lib/realtime-protocol.js";
import type { AnyTaskEvent } from "../../src/events/types.js";

function event(id: string, type = "TOOL_STARTED"): AnyTaskEvent {
  return {
    id,
    type,
    taskId: "TASK-001",
    timestamp: "2026-09-12T21:00:00.000Z",
    payload: { tool: "list_files", agentId: "coder", cycle: 1 },
  } as unknown as AnyTaskEvent;
}

function feedWith(messages: StreamMessage[], options: { limit?: number } = {}) {
  return messages.reduce(
    (state, message) => reduceStreamMessage(state, message, { ...options, now: 1_000 }),
    initialFeedState(),
  );
}

describe("parseStreamMessage", () => {
  it("parses the hello handshake", () => {
    const parsed = parseStreamMessage('{"kind":"hello","configured":true,"transports":["in-memory"]}');
    expect(parsed).toMatchObject({ kind: "hello", configured: true });
  });

  it("parses an event frame", () => {
    const parsed = parseStreamMessage(JSON.stringify({ kind: "event", event: event("e1") }));
    expect(parsed).toMatchObject({ kind: "event" });
  });

  it("rejects malformed JSON instead of throwing", () => {
    expect(parseStreamMessage("{oops")).toBeUndefined();
    expect(parseStreamMessage("")).toBeUndefined();
  });

  it("rejects an event without an id, which could not be deduped", () => {
    expect(parseStreamMessage(JSON.stringify({ kind: "event", event: { type: "X" } }))).toBeUndefined();
  });

  it("ignores unknown message kinds", () => {
    expect(parseStreamMessage('{"kind":"mystery"}')).toBeUndefined();
  });
});

describe("reduceStreamMessage", () => {
  it("reports CONNECTED only once the backlog is complete", () => {
    const handshake = feedWith([{ kind: "hello", configured: true, transports: ["in-memory"] }]);
    expect(handshake.ready).toBe(false);
    expect(handshake.transports).toEqual(["in-memory"]);

    const ready = reduceStreamMessage(handshake, { kind: "backlog-complete" });
    expect(ready.state).toBe("CONNECTED");
    expect(ready.ready).toBe(true);
  });

  it("keeps the newest event first and preserves arrival order within the feed", () => {
    const state = feedWith([
      { kind: "hello", configured: true },
      { kind: "event", event: event("e1") },
      { kind: "event", event: event("e2") },
      { kind: "event", event: event("e3") },
      { kind: "backlog-complete" },
    ]);

    expect(state.entries.map((entry) => entry.key)).toEqual(["e3", "e2", "e1"]);
  });

  it("dedupes a replayed event so a reconnect cannot double-render it", () => {
    const state = feedWith([
      { kind: "event", event: event("e1") },
      { kind: "event", event: event("e1") },
      { kind: "event", event: event("e1") },
    ]);
    expect(state.entries).toHaveLength(1);
  });

  it("bounds the buffer to the configured limit", () => {
    const messages: StreamMessage[] = Array.from({ length: 10 }, (_, index) => ({
      kind: "event",
      event: event(`e${index}`),
    }));
    const state = feedWith(messages, { limit: 3 });
    expect(state.entries.map((entry) => entry.key)).toEqual(["e9", "e8", "e7"]);
  });

  it("marks DISCONNECTED and explains why when no database is configured", () => {
    const state = feedWith([{ kind: "hello", configured: false }]);
    expect(state.state).toBe("DISCONNECTED");
    expect(state.error).toBe("Database is not configured");
  });
});

describe("disconnected fallback", () => {
  it("keeps already-received events on screen while reconnecting", () => {
    const connected = feedWith([
      { kind: "event", event: event("e1") },
      { kind: "backlog-complete" },
    ]);
    const dropped = markDisconnected(connected);

    // Historical data must survive the drop: the UI stays usable.
    expect(dropped.entries).toHaveLength(1);
    expect(dropped.state).toBe("RECONNECTING");
    expect(dropped.ready).toBe(false);
  });

  it("still accepts a later event after the connection recovers", () => {
    const dropped = markDisconnected(feedWith([{ kind: "event", event: event("e1") }]));
    const recovered = reduceStreamMessage(dropped, { kind: "event", event: event("e2") });
    expect(recovered.entries).toHaveLength(2);
  });
});

describe("reconnectDelayMs", () => {
  it("backs off exponentially and stops at the cap", () => {
    expect(reconnectDelayMs(1)).toBe(1_000);
    expect(reconnectDelayMs(2)).toBe(2_000);
    expect(reconnectDelayMs(3)).toBe(4_000);
    expect(reconnectDelayMs(50)).toBe(10_000);
  });
});
