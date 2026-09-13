import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import type { Db } from "../../src/persistence/db.js";
import { PostgresTaskRepository } from "../../src/persistence/repositories/task-repository.js";

describe("Auto Generate External ID", () => {
  let db: Db;
  let repos: { tasks: PostgresTaskRepository };
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    const setup = await createTestDb();
    db = setup.db;
    teardown = setup.close;
    repos = { tasks: setup.tasks };
  });

  afterEach(async () => {
    await teardown();
  });

  it("allocates TASK-001 when the table is empty", async () => {
    const nextId = await repos.tasks.predictNextExternalId();
    expect(nextId).toBe("TASK-001");

    const task = await repos.tasks.createAuto({
      title: "First",
      description: "First task",
      workspace: "/tmp",
      maxReviewCycles: 3,
    });
    expect(task.externalId).toBe("TASK-001");
  });

  it("allocates TASK-011 when TASK-010 exists", async () => {
    await repos.tasks.create({
      externalId: "TASK-010",
      title: "Manual 10",
      description: "Desc",
      workspace: "/tmp",
      maxReviewCycles: 3,
    });

    const nextId = await repos.tasks.predictNextExternalId();
    expect(nextId).toBe("TASK-011");

    const task = await repos.tasks.createAuto({
      title: "Auto 11",
      description: "Desc",
      workspace: "/tmp",
      maxReviewCycles: 3,
    });
    expect(task.externalId).toBe("TASK-011");
  });

  it("fills the gap strictly based on max value (TASK-001, TASK-003 -> TASK-004)", async () => {
    await repos.tasks.create({
      externalId: "TASK-001",
      title: "One",
      description: "Desc",
      workspace: "/tmp",
      maxReviewCycles: 3,
    });
    await repos.tasks.create({
      externalId: "TASK-003",
      title: "Three",
      description: "Desc",
      workspace: "/tmp",
      maxReviewCycles: 3,
    });

    const nextId = await repos.tasks.predictNextExternalId();
    expect(nextId).toBe("TASK-004");
  });

  it("allocates gapless unique IDs under concurrent creation without duplicates", async () => {
    // Seed TASK-001
    await repos.tasks.createAuto({
      title: "Initial",
      description: "Initial task",
      workspace: "/tmp",
      maxReviewCycles: 3,
    });

    // Fire 5 concurrent auto-allocations
    const promises = Array.from({ length: 5 }).map((_, i) =>
      repos.tasks.createAuto({
        title: `Concurrent ${i}`,
        description: `Desc ${i}`,
        workspace: "/tmp",
        maxReviewCycles: 3,
      })
    );

    const results = await Promise.all(promises);
    const ids = results.map(r => r.externalId).sort();

    // They should be completely unique and exactly TASK-002 through TASK-006
    expect(ids).toEqual([
      "TASK-002",
      "TASK-003",
      "TASK-004",
      "TASK-005",
      "TASK-006",
    ]);
  });
});
