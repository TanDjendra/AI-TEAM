/**
 * Realtime hub for the dashboard.
 *
 * One process-wide event bus; browsers attach over SSE. The hub exists because a
 * Next.js server has many independent requests but must present a single live
 * view: without it, each request would build its own bus and see only its own
 * events.
 *
 * Why SSE and not WebSocket here: the dashboard only *receives* events, and SSE
 * works through a plain Next.js route handler with no extra server. The
 * `EventTransport` seam from PHASE 4 is what makes this a swap rather than a
 * rewrite — `BroadcastEventTransport` is just another transport.
 */

import { createEventBus, type EventBus, type EventTransport } from "../events/bus.js";
import type { AnyTaskEvent } from "../events/types.js";
import { redact } from "../persistence/redaction.js";

export interface RealtimeConnection {
  id: string;
  /** Subscribe to events. Returns an unsubscribe function. */
  subscribe(listener: (event: AnyTaskEvent) => void): () => void;
  /** Events to send when the browser connects, so the feed is never empty. */
  backlog(): AnyTaskEvent[];
  close(): void;
}

export interface RealtimeHub {
  readonly bus: EventBus;
  /** Registers a browser connection. */
  connect(): RealtimeConnection;
  /** Number of live connections — surfaced as the connection indicator. */
  connectionCount(): number;
  /** Transports attached to the bus (in-memory, Supabase, WebSocket, …). */
  transports(): string[];
  addTransport(transport: EventTransport): void;
  close(): Promise<void>;
}

export interface RealtimeHubOptions {
  /** Events replayed to a newly connected client. */
  replaySize?: number;
  /** Extra transports (Supabase Realtime, WebSocket) supplied by the caller. */
  transports?: EventTransport[];
  newId?: () => string;
  now?: () => Date;
  onError?: (failure: { stage: string; source: string; message: string }) => void;
}

export function createRealtimeHub(options: RealtimeHubOptions = {}): RealtimeHub {
  const bus = createEventBus({
    replayBufferSize: options.replaySize ?? 200,
    ...(options.newId ? { newId: options.newId } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onError
      ? {
          onError: (failure) =>
            options.onError!({
              stage: failure.stage,
              source: failure.source,
              message: failure.error.message,
            }),
        }
      : {}),
  });

  for (const transport of options.transports ?? []) bus.addTransport(transport);

  let counter = 0;
  const connections = new Set<RealtimeConnection>();

  return {
    bus,

    connect(): RealtimeConnection {
      counter += 1;
      const id = `conn-${counter}`;
      const listeners = new Set<(event: AnyTaskEvent) => void>();

      const unsubscribeBus = bus.subscribe((event) => {
        // Redacted again at the boundary: nothing leaves over the network
        // without passing the same scrubber the database uses.
        const safe = redact(event) as AnyTaskEvent;
        for (const listener of [...listeners]) {
          try {
            listener(safe);
          } catch {
            // A broken client must not affect the others.
          }
        }
      });

      const connection: RealtimeConnection = {
        id,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        backlog() {
          return bus.recent(options.replaySize ?? 200).map((event) => redact(event) as AnyTaskEvent);
        },
        close() {
          listeners.clear();
          unsubscribeBus();
          connections.delete(connection);
        },
      };

      connections.add(connection);
      return connection;
    },

    connectionCount: () => connections.size,

    // Reads the bus's real transport registry. The previous implementation cast
    // the bus to a shape with a `transports` array that never existed, so this
    // always advertised an empty list.
    transports: () => bus.transportNames(),

    addTransport(transport) {
      bus.addTransport(transport);
    },

    async close() {
      for (const connection of [...connections]) connection.close();
      await bus.close();
    },
  };
}

/**
 * A transport that forwards bus events into an existing hub's connections.
 * Used when a second bus (e.g. the orchestrator's) should feed the dashboard.
 */
export class BroadcastEventTransport implements EventTransport {
  readonly name = "dashboard-broadcast";

  constructor(private readonly hub: RealtimeHub) {}

  async publish(event: AnyTaskEvent): Promise<void> {
    // Re-entering the hub's bus is intentional: it fans out to browsers and
    // keeps one replay buffer.
    await this.hub.bus.publish(event);
  }
}
