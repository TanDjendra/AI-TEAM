/**
 * Server-Sent Events stream (the realtime transport).
 *
 * The browser subscribes here. Events are sourced from the DATABASE
 * (`activity_logs`, ordered by `publish_seq`), not from an in-process bus —
 * because the orchestrator runs as a separate process and its events would
 * otherwise never reach this server. The database is the source of truth, so a
 * stream built on it is both correct across processes and able to replay.
 *
 * Flow on connect:
 *   1. `hello`      — whether a database is configured, and the attached transports
 *   2. backlog      — the most recent journaled events, oldest first
 *   3. `backlog-complete`
 *   4. live events  — new rows past the cursor, polled on an interval
 *
 * Because the backlog comes from the journal, a freshly opened dashboard is
 * never blank, and a dropped connection loses nothing: reconnecting replays from
 * the database and the client dedupes on event id.
 *
 * Secrets are redacted by the recorder before storage, so nothing raw is on the
 * wire to begin with.
 */

import { getDashboardRuntime } from "../../../src/dashboard/runtime.js";
import {
  activityToEvent,
  createPersistedEventStream,
  STREAM_BACKLOG,
} from "../../../src/dashboard/event-stream-source.js";
import type { AnyTaskEvent } from "../../../src/events/types.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 20_000;

export async function GET(request: Request) {
  const dashboard = await getDashboardRuntime();
  const encoder = new TextEncoder();

  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (payload: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      // Everything this connection owns, torn down on abort.
      const disposers: Array<() => void> = [() => clearInterval(heartbeat), () => controller.close()];

      const onAbort = (): void => {
        if (closed) return;
        closed = true;
        for (const dispose of disposers.splice(0)) {
          try {
            dispose();
          } catch {
            // already closed
          }
        }
      };

      request.signal.addEventListener("abort", onAbort, { once: true });
      cleanup = onAbort;

      void (async () => {
        // 1. Handshake.
        send({
          kind: "hello",
          configured: dashboard.configured,
          ...(dashboard.error ? { error: dashboard.error } : {}),
          transports: dashboard.hub.transports(),
          serverTime: new Date().toISOString(),
        });

        if (!dashboard.configured || !dashboard.persistence) {
          // Nothing to stream. The UI falls back to the REST endpoints, which
          // keep serving whatever is stored.
          send({ kind: "backlog-complete" });
          return;
        }

        const activityLogs = dashboard.persistence.repositories.activityLogs;

        // 2. Backlog from the journal, oldest first.
        //
        // Rows are converted to the event shape the client protocol expects
        // (id/type/timestamp) before sending — the journal column names are an
        // implementation detail of the storage layer.
        let backlogSeq = 0;
        try {
          const recent = await activityLogs.latest(STREAM_BACKLOG);
          const ordered = [...recent].reverse();
          const seen = new Set<string>();
          for (const row of ordered) {
            if (seen.has(row.eventId)) continue;
            seen.add(row.eventId);
            if (row.publishSeq > backlogSeq) backlogSeq = row.publishSeq;
            send({ kind: "event", event: activityToEvent(row) });
          }
        } catch (error) {
          send({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }
        send({ kind: "backlog-complete" });

        // 3. Live follow. The cursor starts past the backlog so nothing is
        //    replayed twice; the client dedupes regardless.
        //
        //    The source owns its own timer and hands every batch to `onBatch`.
        //    It must be the ONLY poller: a second loop calling `poll()` would
        //    advance the shared cursor and consume rows that this one never got
        //    to send, silently dropping events.
        const source = await createPersistedEventStream({
          persistence: dashboard.persistence,
          startSeq: backlogSeq,
          pollIntervalMs: 1_000,
          onBatch: (events) => {
            for (const event of events) send({ kind: "event", event });
          },
          onError: (message) => send({ kind: "error", message }),
        });

        // Local bus events (same process only) are pushed immediately; the poll
        // is what carries cross-process events.
        const unsubscribeLocal = dashboard.hub.bus.subscribe((event: AnyTaskEvent) => {
          source.push(event);
        });
        disposers.push(unsubscribeLocal);

        source.start();
        disposers.push(() => source.stop());
      })();

      disposers.push(() => {
        closed = true;
      });
    },

    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
