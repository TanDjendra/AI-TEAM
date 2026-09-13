/**
 * Event transports.
 *
 * A transport is the "send it somewhere the dashboard can see it" seam. None of
 * them are required: with no transport the system still works and the database
 * remains the source of truth.
 *
 * Every transport here is *non-blocking by design*: a realtime sink that is down
 * must never stop a task from running. Failures are reported by the bus, not
 * thrown into the orchestrator.
 */

import type { AnyTaskEvent } from "./types.js";
import type { EventTransport } from "./bus.js";
import { redact } from "../persistence/redaction.js";

/**
 * In-process transport. Subscribers are local callbacks, which is what the
 * integration tests and an embedded dashboard use.
 */
export class InMemoryEventTransport implements EventTransport {
  readonly name = "in-memory";
  private readonly events: AnyTaskEvent[] = [];
  private readonly subscribers = new Set<(event: AnyTaskEvent) => void>();
  private readonly maxBuffer: number;

  constructor(options: { maxBuffer?: number } = {}) {
    this.maxBuffer = options.maxBuffer ?? 1_000;
  }

  async publish(event: AnyTaskEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > this.maxBuffer) {
      this.events.splice(0, this.events.length - this.maxBuffer);
    }
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch {
        // A broken subscriber is the subscriber's problem.
      }
    }
  }

  subscribe(subscriber: (event: AnyTaskEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  all(): readonly AnyTaskEvent[] {
    return this.events.slice();
  }

  count(): number {
    return this.events.length;
  }

  async close(): Promise<void> {
    this.subscribers.clear();
    this.events.length = 0;
  }
}

/** Minimal shape of a WebSocket, so tests can inject a stub. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  addEventListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface WebSocketTransportOptions {
  /**
   * Creates a socket on demand. Injected rather than hard-coded so tests do not
   * need a real server, and so the caller owns the URL/auth.
   */
  connect: () => WebSocketLike;
  /** Queue size while the socket is not open. Oldest events are dropped first. */
  maxQueue?: number;
  /** Reconnect backoff base in ms. */
  retryBaseDelayMs?: number;
  maxRetries?: number;
  now?: () => Date;
}

/**
 * WebSocket transport with a bounded outbound queue and reconnect.
 *
 * The socket is created lazily on first publish so importing this module never
 * opens a connection.
 */
export class WebSocketEventTransport implements EventTransport {
  readonly name = "websocket";
  private socket: WebSocketLike | undefined;
  private queue: AnyTaskEvent[] = [];
  private readonly maxQueue: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetries: number;
  private retries = 0;
  private closed = false;

  constructor(private readonly options: WebSocketTransportOptions) {
    this.maxQueue = options.maxQueue ?? 500;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.maxRetries = options.maxRetries ?? 5;
  }

  private isOpen(): boolean {
    return this.socket?.readyState === 1;
  }

  private ensureSocket(): void {
    if (this.closed || this.socket) return;
    try {
      const socket = this.options.connect();
      this.socket = socket;
      const onOpen = (): void => {
        this.retries = 0;
        this.flush();
      };
      const onClose = (): void => {
        this.socket = undefined;
        this.scheduleReconnect();
      };
      socket.on?.("open", onOpen);
      socket.on?.("close", onClose);
      socket.on?.("error", onClose);
    } catch {
      this.socket = undefined;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.retries >= this.maxRetries) return;
    this.retries += 1;
    const delay = this.retryBaseDelayMs * 2 ** (this.retries - 1);
    const timer = setTimeout(() => {
      this.ensureSocket();
      this.flush();
    }, delay);
    timer.unref?.();
  }

  private flush(): void {
    if (!this.isOpen() || !this.socket) return;
    while (this.queue.length > 0) {
      const event = this.queue[0]!;
      try {
        this.socket.send(JSON.stringify(redact(event)));
        this.queue.shift();
      } catch {
        this.socket = undefined;
        this.scheduleReconnect();
        return;
      }
    }
  }

  async publish(event: AnyTaskEvent): Promise<void> {
    this.queue.push(event);
    if (this.queue.length > this.maxQueue) {
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
    this.ensureSocket();
    this.flush();
  }

  /** Number of events waiting for a socket. Exposed for tests/metrics. */
  pending(): number {
    return this.queue.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
    this.socket = undefined;
    this.queue = [];
  }
}

/** The subset of the Supabase client this transport needs. */
export interface SupabaseRealtimeChannel {
  send(args: {
    type: "broadcast";
    event: string;
    payload: unknown;
  }): Promise<unknown> | unknown;
}

export interface SupabaseRealtimeClient {
  channel(name: string): SupabaseRealtimeChannel;
  removeChannel?(channel: SupabaseRealtimeChannel): Promise<unknown> | unknown;
}

export interface SupabaseRealtimeTransportOptions {
  client: SupabaseRealtimeClient;
  /** Broadcast channel the dashboard subscribes to. */
  channel?: string;
  /** Event name inside the channel. */
  eventName?: string;
}

/**
 * Broadcasts events over a Supabase Realtime channel.
 *
 * This is intentionally a thin adapter: it does not connect, subscribe or
 * authenticate anything itself. The caller owns the Supabase client, so this
 * transport stays usable with a mocked client in tests and can never force an
 * external connection on an environment that has no Supabase configured.
 */
export class SupabaseRealtimeEventTransport implements EventTransport {
  readonly name = "supabase-realtime";
  private readonly channel: SupabaseRealtimeChannel;
  private failures = 0;

  constructor(private readonly options: SupabaseRealtimeTransportOptions) {
    this.channel = options.client.channel(options.channel ?? "ai-team-events");
  }

  async publish(event: AnyTaskEvent): Promise<void> {
    try {
      await this.channel.send({
        type: "broadcast",
        event: this.options.eventName ?? "task_event",
        // Redacted: realtime payloads are the most likely place to leak a key.
        payload: redact(event),
      });
    } catch (error) {
      this.failures += 1;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** How many publishes failed. Useful for a health endpoint later. */
  failureCount(): number {
    return this.failures;
  }

  async close(): Promise<void> {
    const client = this.options.client;
    if (client.removeChannel) {
      try {
        await client.removeChannel(this.channel);
      } catch {
        // ignore
      }
    }
  }
}

/** Fans an event out to several transports under one name. */
export class CompositeEventTransport implements EventTransport {
  readonly name: string;
  private readonly transports: EventTransport[];

  constructor(transports: EventTransport[], name = "composite") {
    this.transports = transports;
    this.name = name;
  }

  async publish(event: AnyTaskEvent): Promise<void> {
    const results = await Promise.allSettled(
      this.transports.map((transport) => transport.publish(event)),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length === this.transports.length && failures.length > 0) {
      // Every sink failed: surface it, the bus reports it to the caller.
      const first = failures[0] as PromiseRejectedResult;
      throw first.reason instanceof Error ? first.reason : new Error(String(first.reason));
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.transports.map((transport) => transport.close?.()));
  }
}
