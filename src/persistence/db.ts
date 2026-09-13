/**
 * Database abstraction.
 *
 * The repositories only ever see `Db` / `UnitOfWork`, never `pg` or PGlite. That
 * is what lets the same SQL run against:
 *   - a real PostgreSQL / Supabase Postgres (production),
 *   - an ephemeral PGlite instance (tests) — actual Postgres 18, not a mock.
 */

export interface DbClient {
  /** Runs a parameterised query and returns the rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs a statement or script with no parameters. */
  exec(sql: string): Promise<void>;
}

export interface UnitOfWork extends DbClient {
  readonly id: string;
  /**
   * Takes a transaction-scoped advisory lock on `key`.
   *
   * Held until commit/rollback, so it is a real mutual-exclusion primitive for
   * "only one worker may be inside this critical section". Used to prevent two
   * workers from running the same task and two reviewers from running the same
   * cycle.
   */
  advisoryLock(key: string): Promise<void>;
}

export interface Db extends DbClient {
  /**
   * Runs `fn` inside a transaction. Commits when it resolves, rolls back when it
   * throws — so a partial write (state change without its activity log) is
   * impossible.
   */
  transaction<T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T>;
  /** True when a connection was successfully established. */
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}

/** A raw connection acquired from the driver. */
export interface DriverConnection {
  query(sql: string, params?: readonly unknown[]): Promise<Array<Record<string, unknown>>>;
  exec(sql: string): Promise<void>;
  release(): void;
}

export interface Driver {
  name: string;
  acquire(): Promise<DriverConnection>;
  /** Runs a query on a short-lived connection (no transaction). */
  query(sql: string, params?: readonly unknown[]): Promise<Array<Record<string, unknown>>>;
  exec(sql: string): Promise<void>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}

export class DatabaseError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DatabaseError";
    this.cause = cause;
  }
}

let transactionCounter = 0;

function nextTransactionId(): string {
  transactionCounter += 1;
  return `tx_${transactionCounter}`;
}

/**
 * Wraps a driver into a `Db`.
 *
 * `pg_advisory_xact_lock` is used (rather than the session variant) so the lock
 * is released automatically by the database even if the process dies mid-run —
 * a crashed worker can never leave a task permanently locked.
 */
export function createDb(driver: Driver): Db {
  const inTransaction = async <T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T> => {
    const connection = await driver.acquire();
    const id = nextTransactionId();
    let finished = false;

    const unitOfWork: UnitOfWork = {
      id,
      query: <R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
        connection.query(sql, params) as Promise<R[]>,
      exec: (sql: string) => connection.exec(sql),
      advisoryLock: async (key: string) => {
        // hashtext() gives a stable 32-bit key from the caller's string.
        await connection.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
      },
    };

    try {
      await connection.exec("begin");
      const result = await fn(unitOfWork);
      await connection.exec("commit");
      finished = true;
      return result;
    } catch (error) {
      if (!finished) {
        try {
          await connection.exec("rollback");
        } catch {
          // A failed rollback means the connection is gone; release it anyway.
        }
      }
      throw error instanceof DatabaseError
        ? error
        : new DatabaseError(
            `Transaction ${id} failed and was rolled back: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error,
          );
    } finally {
      connection.release();
    }
  };

  return {
    query: async <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
      (await driver.query(sql, params)) as T[],
    exec: (sql: string) => driver.exec(sql),
    transaction: inTransaction,
    isReady: () => driver.isReady(),
    close: () => driver.close(),
  };
}

/** Runs `fn` in a transaction, or in a nested one when a `Db` is nested in a tx. */
export function withTransaction<T>(
  db: Db | UnitOfWork,
  fn: (tx: UnitOfWork) => Promise<T>,
): Promise<T> {
  if (isUnitOfWork(db)) return fn(db);
  return db.transaction(fn);
}

function isUnitOfWork(value: Db | UnitOfWork): value is UnitOfWork {
  return typeof (value as UnitOfWork).advisoryLock === "function" && "id" in value;
}

/** Repository base: gives every repository the same db/transaction plumbing. */
export abstract class Repository {
  protected constructor(protected readonly db: Db | UnitOfWork) {}

  protected tx(): Db | UnitOfWork {
    return this.db;
  }

  protected run<T>(fn: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    return withTransaction(this.db, fn);
  }
}

/**
 * Retries a database operation on transient failures (connection blips,
 * serialization conflicts). Non-transient errors are rethrown immediately.
 */
export async function withDbRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt >= attempts) break;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

const TRANSIENT_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "53300", // too_many_connections
  "57P01", // admin_shutdown
]);

export function isTransient(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection terminated|server closed the connection/i.test(
    message,
  );
}
