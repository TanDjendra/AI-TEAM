import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createPersistence, type Persistence } from "../../src/persistence/container.js";
import { createRecoveryService } from "../../src/orchestration/recovery.js";
import { silentLogger } from "../../src/domain/logger.js";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

describe("Recovery & Checkpoints", () => {
  let tempDir: string;
  let testDb: TestDb;
  let persistence: Persistence;
  const logger = silentLogger();

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "recovery-test-"));
    testDb = await createTestDb();
    
    persistence = (await createPersistence({
      config: { 
        database: { requirePersistence: true },
        coder: { model: "test-coder" },
        reviewer: { model: "test-reviewer" }
      } as any,
      db: testDb.db,
      logger,
      skipMigrations: true,
    }))!;
  });

  afterEach(async () => {
    await persistence?.close();
    await testDb?.close();
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("sweeper correctly transitions stale tasks to NEEDS_HUMAN", async () => {
    // Manually create a task and set its state to CODING (simulating in-flight crash)
    const task = await persistence.repositories.tasks.create({
      externalId: "TASK-CRASH-1",
      title: "Test",
      description: "Desc",
      workspace: tempDir,
      maxReviewCycles: 3,
    });
    await persistence.repositories.tasks.setStatus(task.id, "CODING", { transitionSeqBump: true });
    
    // Simulate it being stale by setting started_at to the past
    await persistence.db.query(
      `UPDATE tasks SET started_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [task.id]
    );

    const recovery = createRecoveryService({ persistence, logger, staleThresholdMs: 60000 });
    const result = await recovery.recover({ staleTaskStatus: "NEEDS_HUMAN" });

    expect(result.applied.length).toBe(1);
    expect(result.applied[0]?.taskMoved).toBe("NEEDS_HUMAN");

    const recoveredTask = await persistence.repositories.tasks.findById(task.id);
    expect(recoveredTask?.status).toBe("NEEDS_HUMAN");
  });

  test("checkpoint correctly restores currentCycle and phase", async () => {
    const task = await persistence.repositories.tasks.create({
      externalId: "TASK-CHK-1",
      title: "Test",
      description: "Desc",
      workspace: tempDir,
      maxReviewCycles: 3,
    });
    
    // Simulate a checkpoint saved by the orchestrator during cycle 2
    await persistence.repositories.tasks.updateCheckpoint(task.id, "TESTING", { cycle: 2, testingCount: 1 });

    const reloaded = await persistence.repositories.tasks.findById(task.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.currentPhase).toBe("TESTING");
    expect((reloaded?.recoveryMetadata as any)?.cycle).toBe(2);
    expect((reloaded?.recoveryMetadata as any)?.testingCount).toBe(1);
  });
});
