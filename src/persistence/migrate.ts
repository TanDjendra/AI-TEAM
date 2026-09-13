/**
 * Migration runner.
 *
 * Files in `supabase/migrations/*.sql` are applied in filename order and recorded
 * in `schema_migrations`, so re-running is a no-op. Each file runs inside its own
 * transaction: a broken migration leaves the schema untouched.
 *
 * `pgcrypto` and `plpgsql` are available on Supabase Postgres and on PGlite, so
 * the same files work in both.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Db } from "./db.js";
import { DatabaseError } from "./db.js";

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export const MIGRATIONS_TABLE = "schema_migrations";

const MIGRATION_FILE_PATTERN = /^\d+_.*\.sql$/;

export async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    throw new DatabaseError(`Cannot read migrations directory: ${directory}`, error);
  }

  const files = entries
    .filter((entry) => MIGRATION_FILE_PATTERN.test(entry))
    .sort((a, b) => a.localeCompare(b));

  const migrations: MigrationFile[] = [];
  for (const name of files) {
    migrations.push({ name, sql: await readFile(join(directory, name), "utf8") });
  }
  return migrations;
}

export async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.exec(`
    create table if not exists ${MIGRATIONS_TABLE} (
      name        text primary key,
      applied_at  timestamptz not null default now()
    );
  `);
}

/**
 * Applies every pending migration.
 *
 * Ordering comes from the filename prefix (timestamp), which is why files are
 * named `20260914000001_core.sql` and not `core.sql`.
 */
export async function migrate(
  db: Db,
  migrations: readonly MigrationFile[],
): Promise<MigrationResult> {
  await ensureMigrationsTable(db);

  const existing = new Set(
    (await db.query<{ name: string }>(`select name from ${MIGRATIONS_TABLE}`)).map((row) => row.name),
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    if (existing.has(migration.name)) {
      skipped.push(migration.name);
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.query(`insert into ${MIGRATIONS_TABLE} (name) values ($1)`, [migration.name]);
      });
      applied.push(migration.name);
    } catch (error) {
      throw new DatabaseError(
        `Migration ${migration.name} failed and was rolled back: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
    }
  }

  return { applied, skipped };
}

/** Convenience: load from a directory and apply. */
export async function migrateFromDirectory(db: Db, directory: string): Promise<MigrationResult> {
  return migrate(db, await loadMigrations(directory));
}

/** Verifies the schema is present (used by startup checks and tests). */
export async function schemaIsReady(db: Db): Promise<boolean> {
  const required = [
    "agents",
    "tasks",
    "task_runs",
    "reviews",
    "activity_logs",
    "tool_calls",
    "file_changes",
    "test_results",
  ];

  const rows = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public'`,
  );
  const present = new Set(rows.map((row) => row.table_name));
  return required.every((table) => present.has(table));
}
