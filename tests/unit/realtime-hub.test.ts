/**
 * Realtime hub tests.
 *
 * Regression focus: `hub.transports()` used to read a `transports` property off
 * the bus via an unsafe cast. `EventBus` never exposed one, so the list was
 * ALWAYS empty — the dashboard reported "no realtime transports" no matter what
 * was attached. These tests fail loudly if that ever regresses.
 */

import { describe, expect, it } from "vitest";

import { createEventBus, type EventTransport } from "../../src/events/bus.js";
import { BroadcastEventTransport, createRealtimeHub } from "../../src/dashboard/realtime.js";
import type { AnyTaskEvent } from "../../src/events/types.js";

function transport(name: string): EventTransport {
  return { name, publish: async () => {} };
}

function event(id: string, type = "TOOL_STARTED"): AnyTaskEvent {
  return {
    id,
    type,
    taskId: "TASK-001",
    timestamp: "2026-09-12T21:00:00.000Z",
    payload: { tool: "list_files" },
  } as unknown as AnyTaskEvent;
}

describe("EventBus.transportNames", () => {
  it("starts empty", () => {
    expect(createEventBus().transportNames()).toEqual([]);
  });

  it("reflects attached transports in registration order", () => {
    const bus = createEventBus();
    bus.addTransport(transport("first"));
    bus.addTransport(transport("second"));
    expect(bus.transportNames()).toEqual(["first", "second"]);
  });

  it("dedupes by name, matching addTransport's contract", () => {
    const bus = createEventBus();
    bus.addTransport(transport("dup"));
    bus.addTransport(transport("dup"));
    expect(bus.transportNames()).toEqual(["dup"]);
  });

  it("reflects removal", () => {
    const bus = createEventBus();
    bus.addTransport(transport("a"));
    bus.addTransport(transport("b"));
    expect(bus.removeTransport("a")).toBe(true);
    expect(bus.transportNames()).toEqual(["b"]);
  });

  it("returns a copy, so a caller cannot mutate the registry", () => {
    const bus = createEventBus();
    bus.addTransport(transport("only"));
    bus.transportNames().push("injected");
    expect(bus.transportNames()).toEqual(["only"]);
  });
});

describe("RealtimeHub.transports", () => {
  it("is empty only when nothing is attached", () => {
    expect(createRealtimeHub().transports()).toEqual([]);
  });

  it("reports transports passed at construction", () => {
    const hub = createRealtimeHub({ transports: [transport("in-memory")] });
    expect(hub.transports()).toEqual(["in-memory"]);
  });

  it("reports transports added later", () => {
    const hub = createRealtimeHub();
    hub.addTransport(transport("dashboard-hub"));
    hub.addTransport(transport("supabase-realtime"));
    expect(hub.transports()).toEqual(["dashboard-hub", "supabase-realtime"]);
  });

  it("REGRESSION: never silently returns an empty list for attached transports", () => {
    // The bug: an unsafe cast to `{ transports?: string[] }` read a property the
    // bus does not have. Asserted through the hub (the public surface the status
    // endpoint uses) rather than by testing the cast directly.
    const hub = createRealtimeHub({ transports: [new BroadcastEventTransport(createRealtimeHub())] });
    expect(hub.transports()).toHaveLength(1);
    expect(hub.transports()[0]).toBe("dashboard-broadcast");
  });
});

describe("RealtimeHub connections", () => {
  it("tracks the connection count used by the status indicator", () => {
    const hub = createRealtimeHub();
    expect(hub.connectionCount()).toBe(0);

    const first = hub.connect();
    const second = hub.connect();
    expect(hub.connectionCount()).toBe(2);

    first.close();
    expect(hub.connectionCount()).toBe(1);

    second.close();
    expect(hub.connectionCount()).toBe(0);
  });

  it("delivers a published event to subscribers", async () => {
    const hub = createRealtimeHub();
    const connection = hub.connect();
    const received: AnyTaskEvent[] = [];
    connection.subscribe((incoming) => received.push(incoming));

    await hub.bus.publish(event("e1"));
    expect(received.map((entry) => entry.id)).toEqual(["e1"]);
  });

  it("stops delivering after unsubscribe", async () => {
    const hub = createRealtimeHub();
    const connection = hub.connect();
    const received: AnyTaskEvent[] = [];
    const unsubscribe = connection.subscribe((incoming) => received.push(incoming));

    await hub.bus.publish(event("e1"));
    unsubscribe();
    await hub.bus.publish(event("e2"));

    expect(received.map((entry) => entry.id)).toEqual(["e1"]);
  });

  it("serves a backlog so a fresh client is not blank", async () => {
    const hub = createRealtimeHub();
    await hub.bus.publish(event("e1"));
    await hub.bus.publish(event("e2"));

    const backlog = hub.connect().backlog();
    expect(backlog.map((entry) => entry.id)).toEqual(["e1", "e2"]);
  });

  it("isolates a throwing subscriber so other clients still receive events", async () => {
    const hub = createRealtimeHub();
    const broken = hub.connect();
    broken.subscribe(() => {
      throw new Error("client exploded");
    });

    const healthy = hub.connect();
    const received: AnyTaskEvent[] = [];
    healthy.subscribe((incoming) => received.push(incoming));

    await expect(hub.bus.publish(event("e1"))).resolves.toBeUndefined();
    expect(received.map((entry) => entry.id)).toEqual(["e1"]);
  });

  it("redacts secrets before an event reaches a browser", async () => {
    const hub = createRealtimeHub();
    const connection = hub.connect();
    const received: AnyTaskEvent[] = [];
    connection.subscribe((incoming) => received.push(incoming));

    await hub.bus.publish({
      ...event("e-secret", "TOOL_STARTED"),
      payload: { tool: "run_command", apiKey: "sk-live-abcdef0123456789" },
    } as unknown as AnyTaskEvent);

    const rendered = JSON.stringify(received);
    expect(rendered).not.toContain("sk-live-abcdef0123456789");
    expect(rendered).toContain("[REDACTED]");
  });
});

describe("BroadcastEventTransport", () => {
  it("forwards an event from a foreign bus into the hub", async () => {
    const hub = createRealtimeHub();
    const connection = hub.connect();
    const received: AnyTaskEvent[] = [];
    connection.subscribe((incoming) => received.push(incoming));

    const foreign = createEventBus();
    foreign.addTransport(new BroadcastEventTransport(hub));
    await foreign.publish(event("from-orchestrator"));

    expect(received.map((entry) => entry.id)).toEqual(["from-orchestrator"]);
  });

  it("advertises a stable name", () => {
    expect(new BroadcastEventTransport(createRealtimeHub()).name).toBe("dashboard-broadcast");
  });
});
