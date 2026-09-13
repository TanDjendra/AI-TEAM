/**
 * Persistence composition root.
 *
 * Builds the database, runs migrations, wires the repositories, the event bus,
 * the transports and the recorder — and hands the orchestrator a single
 * `OrchestratorHooks`.
 *
 * Nothing here connects to anything external unless a database URL is
 * configured. With `database.url` unset the function returns `persistence:
 * undefined` and the orchestrator runs exactly as it did before this phase.
 */

import { createEventBus, type EventBus, type EventTransport } from "../events/bus.js";
import {
  CompositeEventTransport,
  InMemoryEventTransport,
  WebSocketEventTransport,
  type WebSocketLike,
  type SupabaseRealtimeClient,
  SupabaseRealtimeEventTransport,
} from "../events/transports.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../domain/logger.js";
import { createDb, type Db, type Driver } from "./db.js";
import { PgDriver, type PgDriverOptions } from "./drivers.js";
import { migrateFromDirectory, schemaIsReady } from "./migrate.js";
import { PostgresActivityLogRepository } from "./repositories/activity-log-repository.js";
import { PostgresAgentRepository } from "./repositories/agent-repository.js";
import {
  createEventRecorder,
  type EventRecorder,
  type RecorderRepositories,
} from "./repositories/event-recorder.js";
import { PostgresFileChangeRepository } from "./repositories/file-change-repository.js";
import { PostgresInterruptRepository } from "./repositories/interrupt-repository.js";
import { PostgresReviewRepository } from "./repositories/review-repository.js";
import { PostgresRunRepository } from "./repositories/run-repository.js";
import { PostgresTaskRepository } from "./repositories/task-repository.js";
import { PostgresTestResultRepository } from "./repositories/test-result-repository.js";
import { PostgresToolCallRepository } from "./repositories/tool-call-repository.js";

export interface PersistenceOptions {
  config: AppConfig;
  logger: Logger;
  /**
   * Reuse an existing database handle (tests). When given, `driver` is ignored
   * and migrations are skipped — the caller already owns the schema.
   */
  db?: Db;
  /**
   * Override the driver. Tests pass a PGlite-backed driver so the same SQL runs
   * against a real Postgres without a server.
   */
  driver?: Driver;
  /** Skip migration (tests apply migrations themselves). */
  skipMigrations?: boolean;
  /**
   * Start an embedded PostgreSQL (PGlite) persisted at this directory. Used when
   * `config.database.pgliteDir` is set and no explicit driver/db is supplied.
   * The caller owns the instance's lifetime and must pass the same one to every
   * consumer in the process (see loadPglite).
   */
  pgliteLoader?: (dir: string) => Promise<Driver>;
  /** Extra transports to fan events out to. */
  transports?: EventTransport[];
  /** Supabase Realtime, when the environment provides a client. */
  supabase?: { client: SupabaseRealtimeClient; channel?: string };
  /** WebSocket sink, when the environment provides one. */
  websocket?: { connect: () => WebSocketLike; maxQueue?: number };
  /** Replay buffer size for late-joining dashboards. */
  replayBufferSize?: number;
  /** Injectable clock/id for deterministic tests. */
  now?: () => Date;
  newId?: () => string;
}

import { PostgresWorkerRepository, type WorkerRepository } from "./repositories/worker-repository.js";

export interface Persistence {
  db: Db;
  bus: EventBus;
  recorder: EventRecorder;
  repositories: RecorderRepositories;
  workers: WorkerRepository;
  /** The transport events were actually routed to. */
  transport: EventTransport;
  /** Live agent ids keyed by role, for events that reference them. */
  agentIds: { coder?: string; reviewer?: string };
  /** Agent keys used in the database. */
  agentKeys: { coder: string; reviewer: string };
  /** Non-fatal problems worth surfacing at startup. */
  warnings: string[];
  close(): Promise<void>;
}

export const CODER_AGENT_KEY = "coder-agent";
export const REVIEWER_AGENT_KEY = "reviewer-agent";

/**
 * Process-wide embedded Postgres (PGlite) loader.
 *
 * PGlite is single-instance per directory: two `PGlite` objects on the same path
 * corrupt each other. This caches one per directory for the process lifetime,
 * which is also what lets the Next.js dev server reuse it across hot reloads.
 */
const pgliteInstances = new Map<string, Driver>();

export async function loadPglite(dir: string): Promise<Driver> {
  const cached = pgliteInstances.get(dir);
  if (cached) return cached;

  const { PGlite } = (await import("@electric-sql/pglite")) as {
    PGlite: new (dataDir: string) => unknown;
  };
  const { PgliteDriver } = await import("./drivers.js");

  // PGlite's node filesystem creates the data directory non-recursively, so a
  // nested path (e.g. ./.data/pglite) fails unless the parent already exists.
  const { mkdir } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const absolute = resolve(dir);
  await mkdir(absolute, { recursive: true });

  const instance = new PGlite(absolute);
  const driver = new PgliteDriver(instance as never);
  pgliteInstances.set(dir, driver);
  return driver;
}

/**
 * Builds the persistence stack for a configured database.
 * Returns undefined when there is no database URL — not an error.
 */
export async function createPersistence(
  options: PersistenceOptions,
): Promise<Persistence | undefined> {
  const { config, logger } = options;
  const hasEmbedded = Boolean(config.database.pgliteDir && options.pgliteLoader);
  if (!config.database.url && !options.driver && !options.db && !hasEmbedded) {
    logger.info("persistence.disabled", {
      reason: config.database.pgliteDir
        ? "PGLITE_DATA_DIR is set but no embedded loader was provided"
        : "Neither DATABASE_URL nor PGLITE_DATA_DIR is set",
      note: "events are still published to the bus, but nothing is stored",
    });
    return undefined;
  }

  const warnings: string[] = [];

  const driver: Driver | undefined =
    options.db !== undefined
      ? undefined
      : (options.driver ??
        (hasEmbedded
          ? await options.pgliteLoader!(config.database.pgliteDir!)
          : new PgDriver({
              ...(config.database.url ? { connectionString: config.database.url } : {}),
              max: config.database.maxConnections,
              ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
              applicationName: "ai-team-orchestrator",
            } satisfies PgDriverOptions)));

  const db = options.db ?? createDb(driver!);

  if (!(await db.isReady())) {
    throw new Error(
      `Database is not reachable. Check DATABASE_URL (Postgres/Supabase Postgres). Refusing to start with persistence half-configured.`,
    );
  }

  if (!options.skipMigrations && options.db === undefined) {
    const result = await migrateFromDirectory(db, config.database.migrationsDir);
    logger.info("persistence.migrated", {
      applied: result.applied.length,
      skipped: result.skipped.length,
    });
  }

  if (!(await schemaIsReady(db))) {
    warnings.push("schema is not fully present after migration; some repositories may fail");
    logger.warn("persistence.schema_incomplete", {});
  }

  const repositories: RecorderRepositories = {
    tasks: new PostgresTaskRepository(db),
    agents: new PostgresAgentRepository(db),
    runs: new PostgresRunRepository(db),
    reviews: new PostgresReviewRepository(db),
    activityLogs: new PostgresActivityLogRepository(db),
    toolCalls: new PostgresToolCallRepository(db),
    fileChanges: new PostgresFileChangeRepository(db),
    testResults: new PostgresTestResultRepository(db),
    interrupts: new PostgresInterruptRepository(db),
  };

  // Agents are registered up front so events can reference real ids.
  const coderAgent = await repositories.agents.upsert({
    agentKey: CODER_AGENT_KEY,
    role: "coder",
    provider: "9router",
    model: config.coder.model,
  });
  const reviewerAgent = await repositories.agents.upsert({
    agentKey: REVIEWER_AGENT_KEY,
    role: "reviewer",
    provider: "9router",
    model: config.reviewer.model,
  });
  const agentIds = { coder: coderAgent.id, reviewer: reviewerAgent.id };

  // Transports. In-memory always present so an in-process dashboard works.
  const sinks: EventTransport[] = [new InMemoryEventTransport()];
  if (options.supabase) {
    sinks.push(
      new SupabaseRealtimeEventTransport({
        client: options.supabase.client,
        ...(options.supabase.channel ? { channel: options.supabase.channel } : {}),
      }),
    );
  }
  if (options.websocket) {
    sinks.push(
      new WebSocketEventTransport({
        connect: options.websocket.connect,
        ...(options.websocket.maxQueue === undefined
          ? {}
          : { maxQueue: options.websocket.maxQueue }),
      }),
    );
  }
  if (options.transports?.length) sinks.push(...options.transports);

  const transport =
    sinks.length === 1 ? sinks[0]! : new CompositeEventTransport(sinks, "persistence-transports");

  const bus = createEventBus({
    replayBufferSize: options.replayBufferSize ?? 1_000,
    ...(options.now ? { now: options.now } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
    onError: (failure) => {
      logger.error("event.bus_error", {
        stage: failure.stage,
        source: failure.source,
        type: failure.event.type,
        eventId: failure.event.id,
        error: failure.error.message,
      });
    },
  });
  bus.addTransport(transport);

  const recorder = createEventRecorder({
    repositories,
    logger,
    onFailure: (failure) => {
      if (failure.fatal) warnings.push(`fatal recorder failure: ${failure.message}`);
    },
  });
  recorder.attach(bus);

  logger.info("persistence.ready", {
    transports: sinks.map((sink) => sink.name).join(","),
    coderAgentId: coderAgent.id,
    reviewerAgentId: reviewerAgent.id,
  });

  return {
    db,
    bus,
    recorder,
    repositories,
    workers: new PostgresWorkerRepository(db),
    transport,
    agentIds,
    agentKeys: { coder: CODER_AGENT_KEY, reviewer: REVIEWER_AGENT_KEY },
    warnings,
    close: async () => {
      await bus.close();
      // When the caller supplied the db, they own its lifetime.
      if (!options.db) await db.close();
    },
  };
}
