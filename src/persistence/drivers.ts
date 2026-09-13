/**
 * Concrete database drivers.
 *
 * - `PgDriver`      → real PostgreSQL / Supabase Postgres, via `pg`.
 * - `PgliteDriver`  → an embedded PostgreSQL (PGlite compiles actual Postgres to
 *                     WASM), used by the integration tests so they run against a
 *                     genuine engine with real transactions and advisory locks,
 *                     with no server or Docker required.
 *
 * Both are thin: they only turn `pg`/PGlite into the `Driver` contract.
 */

import type { Driver, DriverConnection } from "./db.js";
import { DatabaseError } from "./db.js";

export interface PgDriverOptions {
  connectionString?: string;
  max?: number;
  connectionTimeoutMillis?: number;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  applicationName?: string;
}

/**
 * PostgreSQL driver.
 *
 * `pg` is imported lazily so that a project running purely on PGlite (tests, or
 * an embedded deployment) does not pay for it, and an ESM/CJS interop problem in
 * `pg` cannot break module loading.
 */
export class PgDriver implements Driver {
  readonly name = "postgres";
  private pool: PoolLike | undefined;
  private ready = false;

  constructor(private readonly options: PgDriverOptions = {}) {}

  private async getPool(): Promise<PoolLike> {
    if (this.pool) return this.pool;

    const module = (await import("pg")) as unknown as { default?: unknown; Pool?: unknown };
    const pg = (module.default ?? module) as { Pool: new (config: unknown) => PoolLike };
    if (typeof pg.Pool !== "function") {
      throw new DatabaseError("Could not load the 'pg' Pool constructor");
    }

    const pool = new pg.Pool({
      ...(this.options.connectionString ? { connectionString: this.options.connectionString } : {}),
      max: this.options.max ?? 10,
      connectionTimeoutMillis: this.options.connectionTimeoutMillis ?? 10_000,
      application_name: this.options.applicationName ?? "ai-team-orchestrator",
      ...(this.options.ssl === undefined ? {} : { ssl: this.options.ssl }),
    });

    // A pool error must not become an unhandled exception.
    pool.on?.("error", () => {});
    this.pool = pool;
    return pool;
  }

  async acquire(): Promise<DriverConnection> {
    const pool = await this.getPool();
    const client = await pool.connect();
    this.ready = true;
    return {
      query: async (sql, params) => {
        try {
          const result = await client.query(sql, params as unknown[] | undefined);
          return (result.rows ?? []) as Array<Record<string, unknown>>;
        } catch (error) {
          throw toDatabaseError(error);
        }
      },
      exec: async (sql) => {
        try {
          await client.query(sql);
        } catch (error) {
          throw toDatabaseError(error);
        }
      },
      release: () => client.release(),
    };
  }

  async query(sql: string, params?: readonly unknown[]): Promise<Array<Record<string, unknown>>> {
    const connection = await this.acquire();
    try {
      return await connection.query(sql, params);
    } finally {
      connection.release();
    }
  }

  async exec(sql: string): Promise<void> {
    const connection = await this.acquire();
    try {
      await connection.exec(sql);
    } finally {
      connection.release();
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.query("select 1");
      this.ready = true;
      return true;
    } catch {
      this.ready = false;
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool?.end?.();
    this.pool = undefined;
  }
}

interface PoolLike {
  connect(): Promise<PgClientLike>;
  end?(): Promise<void>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}

interface PgClientLike {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows?: Array<Record<string, unknown>> }>;
  release(): void;
}

/** The subset of the PGlite instance this driver uses. */
export interface PgliteLike {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close?(): Promise<void>;
}

/**
 * Embedded Postgres driver (tests).
 *
 * PGlite serialises work internally, so `acquire()` hands out a view of the same
 * instance. Its transaction handling is real, which is the property the
 * idempotency and atomicity tests depend on.
 */
export class PgliteDriver implements Driver {
  readonly name = "pglite";
  private readonly locks = new Map<string, Promise<void>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PgliteLike) {}

  /**
   * PGlite runs in one process, so concurrent transactions would interleave on a
   * single connection. Mutexing acquisition is what makes the concurrency tests
   * meaningful rather than flaky.
   */
  async acquire(): Promise<DriverConnection> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    return {
      query: async (sql, params) => {
        try {
          const result = await this.db.query(sql, params);
          return result.rows as Array<Record<string, unknown>>;
        } catch (error) {
          throw toDatabaseError(error);
        }
      },
      exec: async (sql) => {
        try {
          await this.db.exec(sql);
        } catch (error) {
          throw toDatabaseError(error);
        }
      },
      release: () => release(),
    };
  }

  async query(sql: string, params?: readonly unknown[]): Promise<Array<Record<string, unknown>>> {
    const connection = await this.acquire();
    try {
      return await connection.query(sql, params);
    } finally {
      connection.release();
    }
  }

  async exec(sql: string): Promise<void> {
    const connection = await this.acquire();
    try {
      await connection.exec(sql);
    } finally {
      connection.release();
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.db.query("select 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.db.close?.();
    this.locks.clear();
  }
}

function toDatabaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new DatabaseError(message, error);
  const code = (error as { code?: string } | null)?.code;
  if (code) (wrapped as { code?: string }).code = code;
  return wrapped;
}
