/**
 * Persistence integration tests — real PostgreSQL (PGlite), real SQL, real
 * transactions. No mocks, no fake success.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestDb,
  resetTestDb,
  seedAgents,
  seedTask,
  type TestDb,
} from "./helpers/test-db.js";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
}, 60_000);

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await resetTestDb(testDb);
});

describe("schema + migrations", () => {
  it("creates every required table", async () => {
    const rows = await testDb.db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const tables = rows.map((row: { table_name: string }) => row.table_name);

    for (const expected of [
      "agents",
      "tasks",
      "task_runs",
      "reviews",
      "activity_logs",
      "tool_calls",
      "file_changes",
      "test_results",
      "schema_migrations",
      // Phase V2-04: Workflow DAG tables
      "workflows",
      "workflow_nodes",
      "workflow_dependencies",
    ]) {
      expect(tables, `missing table ${expected}`).toContain(expected);
    }
  });

  it("applies migrations idempotently", async () => {
    const { migrateFromDirectory } = await import("../../src/persistence/migrate.js");
    const { MIGRATIONS_DIR } = await import("./helpers/test-db.js");

    const first = await migrateFromDirectory(testDb.db, MIGRATIONS_DIR);
    expect(first.applied).toHaveLength(0);
    expect(first.skipped.length).toBeGreaterThan(0);
  });
});

describe("AgentRepository", () => {
  it("registers an agent and starts IDLE", async () => {
    const agent = await testDb.agents.register({
      agentKey: "coder-agent",
      role: "coder",
      provider: "9router",
      model: "grip/deepseek-v4.1-flash",
    });

    expect(agent.status).toBe("IDLE");
    expect(agent.agentKey).toBe("coder-agent");
    expect(agent.currentTaskId).toBeUndefined();
  });

  it("is idempotent on agent_key", async () => {
    const first = await testDb.agents.register({
      agentKey: "coder-agent",
      role: "coder",
      provider: "9router",
      model: "m1",
    });
    const second = await testDb.agents.register({
      agentKey: "coder-agent",
      role: "coder",
      provider: "9router",
      model: "m1",
    });

    expect(second.id).toBe(first.id);
    const all = await testDb.agents.list();
    expect(all.filter((agent) => agent.agentKey === "coder-agent")).toHaveLength(1);
  });

  it("upsert updates the model without creating a duplicate", async () => {
    await testDb.agents.upsert({
      agentKey: "coder-agent",
      role: "coder",
      provider: "9router",
      model: "old",
    });
    const updated = await testDb.agents.upsert({
      agentKey: "coder-agent",
      role: "coder",
      provider: "9router",
      model: "new",
    });

    expect(updated.model).toBe("new");
    expect(await testDb.agents.list()).toHaveLength(1);
  });

  it("tracks WORKING -> REVIEWING -> IDLE", async () => {
    const { coderId, reviewerId } = await seedAgents(testDb);
    const task = await seedTask(testDb);

    await testDb.agents.setStatus(coderId, "WORKING", { currentTaskId: task.id });
    let coder = await testDb.agents.findById(coderId);
    expect(coder?.status).toBe("WORKING");
    expect(coder?.currentTaskId).toBe(task.id);

    // The coder goes back to IDLE while the reviewer takes over.
    await testDb.agents.setStatus(coderId, "IDLE", { currentTaskId: null });
    await testDb.agents.setStatus(reviewerId, "REVIEWING", { currentTaskId: task.id });

    coder = await testDb.agents.findById(coderId);
    const reviewer = await testDb.agents.findById(reviewerId);
    expect(coder?.status).toBe("IDLE");
    expect(coder?.currentTaskId).toBeUndefined();
    expect(reviewer?.status).toBe("REVIEWING");
    expect(reviewer?.currentTaskId).toBe(task.id);
  });

  it("reflects status changes in last_seen", async () => {
    const { coderId } = await seedAgents(testDb);
    const before = await testDb.agents.findById(coderId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await testDb.agents.setStatus(coderId, "WORKING");
    const after = await testDb.agents.findById(coderId);

    expect(Date.parse(after!.lastSeen)).toBeGreaterThanOrEqual(Date.parse(before!.lastSeen));
  });
});
