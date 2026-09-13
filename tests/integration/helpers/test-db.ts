/**
 * Integration test harness.
 *
 * Boots a REAL PostgreSQL (PGlite compiles Postgres to WASM), applies the real
 * migrations, and hands back the real repositories. Nothing here is a mock: the
 * transactional guarantees these tests assert (atomic transitions, idempotency,
 * advisory locks, unique constraints) only exist in an actual engine.
 */

import { PGlite } from "@electric-sql/pglite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDb, type Db } from "../../../src/persistence/db.js";
import { PgliteDriver, type PgliteLike } from "../../../src/persistence/drivers.js";
import { migrateFromDirectory } from "../../../src/persistence/migrate.js";
import { PostgresActivityLogRepository } from "../../../src/persistence/repositories/activity-log-repository.js";
import { PostgresAgentRepository } from "../../../src/persistence/repositories/agent-repository.js";
import { PostgresFileChangeRepository } from "../../../src/persistence/repositories/file-change-repository.js";
import { PostgresInterruptRepository } from "../../../src/persistence/repositories/interrupt-repository.js";
import { PostgresReviewRepository } from "../../../src/persistence/repositories/review-repository.js";
import { PostgresRunRepository } from "../../../src/persistence/repositories/run-repository.js";
import { PostgresTaskRepository } from "../../../src/persistence/repositories/task-repository.js";
import { PostgresTestResultRepository } from "../../../src/persistence/repositories/test-result-repository.js";
import { PostgresToolCallRepository } from "../../../src/persistence/repositories/tool-call-repository.js";

export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);

export interface TestDb {
  db: Db;
  tasks: PostgresTaskRepository;
  agents: PostgresAgentRepository;
  runs: PostgresRunRepository;
  reviews: PostgresReviewRepository;
  activityLogs: PostgresActivityLogRepository;
  toolCalls: PostgresToolCallRepository;
  fileChanges: PostgresFileChangeRepository;
  testResults: PostgresTestResultRepository;
  interrupts: PostgresInterruptRepository;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite();
  const driver = new PgliteDriver(pglite as unknown as PgliteLike);
  const db = createDb(driver);

  const result = await migrateFromDirectory(db, MIGRATIONS_DIR);
  if (result.applied.length === 0 && result.skipped.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  }

  return {
    db,
    tasks: new PostgresTaskRepository(db),
    agents: new PostgresAgentRepository(db),
    runs: new PostgresRunRepository(db),
    reviews: new PostgresReviewRepository(db),
    activityLogs: new PostgresActivityLogRepository(db),
    toolCalls: new PostgresToolCallRepository(db),
    fileChanges: new PostgresFileChangeRepository(db),
    testResults: new PostgresTestResultRepository(db),
    interrupts: new PostgresInterruptRepository(db),
    close: () => db.close(),
  };
}

/** Registers the two standard agents and returns their ids. */
export async function seedAgents(testDb: TestDb): Promise<{ coderId: string; reviewerId: string }> {
  const coder = await testDb.agents.upsert({
    agentKey: "coder-agent",
    role: "coder",
    provider: "9router",
    model: "grip/deepseek-v4.1-flash",
  });
  const reviewer = await testDb.agents.upsert({
    agentKey: "reviewer-agent",
    role: "reviewer",
    provider: "9router",
    model: "grip/gpt-5.6-luna",
  });
  return { coderId: coder.id, reviewerId: reviewer.id };
}

/**
 * Empties every table.
 *
 * PGlite boots a Postgres instance per process (~0.8s), so the suite shares one
 * instance per test file and resets between tests instead of paying that cost
 * per case. `cascade` handles the foreign keys.
 */
export async function resetTestDb(testDb: TestDb): Promise<void> {
  await testDb.db.exec(
    `truncate table activity_logs, tool_calls, file_changes, test_results, reviews, task_runs, tasks, agents, task_interrupts cascade;`,
  );
}

/** Creates a task and returns its row. */
export async function seedTask(
  testDb: TestDb,
  overrides: { externalId?: string; workspace?: string; maxReviewCycles?: number } = {},
) {
  return testDb.tasks.create({
    externalId: overrides.externalId ?? "TASK-TEST-001",
    title: "Integration task",
    description: "A task used by the persistence integration tests.",
    workspace: overrides.workspace ?? "/tmp/workspace/TASK-TEST-001",
    maxReviewCycles: overrides.maxReviewCycles ?? 3,
  });
}
