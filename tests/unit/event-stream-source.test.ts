/**
 * Database-backed event stream tests.
 *
 * The stream exists because the orchestrator and the dashboard are separate
 * processes: an in-process bus is not enough to see a task run. These tests pin
 * the cursor behaviour that makes that work — no missed rows, no replays.
 */

import { describe, expect, it } from "vitest";

import {
  activityToEvent,
  createPersistedEventStream,
} from "../../src/dashboard/event-stream-source.js";
import type { Persistence } from "../../src/persistence/container.js";
import type { ActivityLogRecord } from "../../src/persistence/repositories/activity-log-repository.js";

function row(seq: number, overrides: Partial<ActivityLogRecord> = {}): ActivityLogRecord {
  return {
    eventId: `evt-${seq}`,
    taskId: "11111111-1111-1111-1111-111111111111",
    agentId: "5b440289-4f6b-46df-bf20-c77f04e43492",
    eventType: "TOOL_STARTED",
    payload: { tool: "list_files" },
    occurredAt: "2026-09-12T21:00:00.000Z",
    createdAt: "2026-09-12T21:00:00.000Z",
    publishSeq: seq,
    ...overrides,
  };
}

/** A journal that only ever grows, like the real table. */
function fakePersistence(rows: ActivityLogRecord[] = []) {
  const table = [...rows];
  const calls = { listAfterSeq: 0 };

  const persistence = {
    repositories: {
      activityLogs: {
        async latest(limit = 100) {
          return table.slice(Math.max(0, table.length - limit)).reverse();
        },
        async maxSeq() {
          return table.reduce((max, entry) => Math.max(max, entry.publishSeq), 0);
        },
        async listAfterSeq(seq: number, limit = 200) {
          calls.listAfterSeq += 1;
          return table
            .filter((entry) => entry.publishSeq > seq)
            .sort((a, b) => a.publishSeq - b.publishSeq)
            .slice(0, limit);
        },
      },
    },
  } as unknown as Persistence;

  return { persistence, table, calls };
}

describe("activityToEvent", () => {
  it("maps a journal row onto the event shape the client protocol requires", () => {
    const event = activityToEvent(row(7));
    expect(event.id).toBe("evt-7");
    expect(event.type).toBe("TOOL_STARTED");
    expect(event.timestamp).toBe("2026-09-12T21:00:00.000Z");
    expect(event.taskId).toBe("11111111-1111-1111-1111-111111111111");
    expect(event.agentId).toBe("5b440289-4f6b-46df-bf20-c77f04e43492");
    // The cursor travels with the event so ordering is auditable downstream.
    expect((event.payload as Record<string, unknown>).publishSeq).toBe(7);
  });
});

describe("createPersistedEventStream", () => {
  it("starts after the current head so a fresh client gets no replay", async () => {
    const { persistence } = fakePersistence([row(1), row(2), row(3)]);
    const stream = await createPersistedEventStream({ persistence });
    expect(stream.cursor()).toBe(3);
    expect(await stream.poll()).toEqual([]);
  });

  it("delivers rows journaled by another process after the cursor", async () => {
    const { persistence, table } = fakePersistence([row(1), row(2)]);
    const stream = await createPersistedEventStream({ persistence });

    // Another process writes two events.
    table.push(row(3), row(4));

    const events = await stream.poll();
    expect(events.map((event) => event.id)).toEqual(["evt-3", "evt-4"]);
    expect(stream.cursor()).toBe(4);
  });

  it("does not replay a row it already delivered", async () => {
    const { persistence, table } = fakePersistence([row(1)]);
    const stream = await createPersistedEventStream({ persistence });
    table.push(row(2));

    expect((await stream.poll()).map((event) => event.id)).toEqual(["evt-2"]);
    // Second poll must be empty: the cursor has moved past evt-2.
    expect(await stream.poll()).toEqual([]);
  });

  it("resumes from an explicit backlog cursor without skipping new rows", async () => {
    const { persistence, table } = fakePersistence([row(1), row(2)]);
    // The route sent rows up to seq 2 as backlog, so polling begins at 2 and
    // there is nothing further yet.
    const stream = await createPersistedEventStream({ persistence, startSeq: 2 });

    expect(await stream.poll()).toEqual([]);

    // A row written after the backlog must still arrive.
    table.push(row(3));
    expect((await stream.poll()).map((event) => event.id)).toEqual(["evt-3"]);
  });

  it("delivers a row that was not part of the backlog", async () => {
    const { persistence } = fakePersistence([row(1), row(2), row(3)]);
    // Cursor at 2 while row 3 is already stored: it was not sent as backlog, so
    // the first poll must pick it up rather than treating it as already seen.
    const stream = await createPersistedEventStream({ persistence, startSeq: 2 });
    expect((await stream.poll()).map((event) => event.id)).toEqual(["evt-3"]);
  });

  it("carries in-process events pushed by the local bus", async () => {
    const { persistence } = fakePersistence([row(1)]);
    const stream = await createPersistedEventStream({ persistence });

    const local = activityToEvent(row(99, { eventId: "local-1" }));
    stream.push(local);

    expect((await stream.poll()).map((event) => event.id)).toEqual(["local-1"]);
    // Pushed events are consumed once.
    expect(await stream.poll()).toEqual([]);
  });

  it("surfaces a read failure instead of throwing", async () => {
    const errors: string[] = [];
    const persistence = {
      repositories: {
        activityLogs: {
          async maxSeq() {
            return 0;
          },
          async latest() {
            return [];
          },
          async listAfterSeq() {
            throw new Error("connection reset");
          },
        },
      },
    } as unknown as Persistence;

    const stream = await createPersistedEventStream({
      persistence,
      onError: (message) => errors.push(message),
    });

    await expect(stream.poll()).resolves.toEqual([]);
    expect(errors).toEqual(["connection reset"]);
  });

  it("survives a missing table when choosing the initial cursor", async () => {
    const persistence = {
      repositories: {
        activityLogs: {
          async maxSeq() {
            throw new Error("relation does not exist");
          },
          async latest() {
            return [];
          },
          async listAfterSeq() {
            return [];
          },
        },
      },
    } as unknown as Persistence;

    const stream = await createPersistedEventStream({ persistence });
    expect(stream.cursor()).toBe(0);
  });

  it("starts and stops its poll timer", async () => {
    const { persistence } = fakePersistence([]);
    const scheduled: Array<() => void> = [];
    let cleared = 0;

    const stream = await createPersistedEventStream({
      persistence,
      setIntervalFn: ((fn: () => void) => {
        scheduled.push(fn);
        return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => {
        cleared += 1;
      }) as unknown as typeof clearInterval,
    });

    stream.start();
    expect(scheduled).toHaveLength(1);
    // A second start must not stack timers.
    stream.start();
    expect(scheduled).toHaveLength(1);

    stream.stop();
    expect(cleared).toBe(1);
  });

  it("delivers each row exactly once through the batch callback", async () => {
    // Guards the real production bug: two pollers sharing one cursor, where the
    // first consumed rows the second never sent.
    const batches: string[][] = [];
    const { persistence, table } = fakePersistence([row(1)]);

    const stream = await createPersistedEventStream({
      persistence,
      onBatch: (events) => batches.push(events.map((event) => event.id)),
    });

    table.push(row(2), row(3));
    await stream.poll();
    // A single poller drains both; nothing is left for a second consumer.
    expect(batches.flat()).toEqual(["evt-2", "evt-3"]);

    await stream.poll();
    expect(batches.flat()).toEqual(["evt-2", "evt-3"]);
  });
});
