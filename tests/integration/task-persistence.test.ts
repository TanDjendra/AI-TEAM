/**
 * Task persistence, atomic state transitions, idempotency and concurrency.
 * Runs against real PostgreSQL (PGlite).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, resetTestDb, seedAgents, seedTask, type TestDb } from "./helpers/test-db.js";
import {
  PERSISTED_TRANSITION_TABLE,
  knownTransition,
} from "../../src/persistence/repositories/task-repository.js";
import { canTransition as domainCanTransition } from "../../src/domain/task-machine.js";
import type { TaskState } from "../../src/domain/types.js";
import type { TaskStatus } from "../../src/events/types.js";

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

describe("TaskRepository", () => {
  it("creates a task with the full required column set", async () => {
    const task = await testDb.tasks.create({
      externalId: "TASK-001",
      title: "Create a slugify module",
      description: "Implement and test slugify.",
      workspace: "/ws/TASK-001",
      maxReviewCycles: 3,
    });

    expect(task.externalId).toBe("TASK-001");
    expect(task.title).toBe("Create a slugify module");
    expect(task.status).toBe("PENDING");
    expect(task.workspace).toBe("/ws/TASK-001");
    expect(task.currentCycle).toBe(0);
    expect(task.maxReviewCycles).toBe(3);
    expect(task.approved).toBe(false);
    expect(task.stopReason).toBeUndefined();
    expect(task.completedAt).toBeUndefined();
    expect(task.createdAt).toBeTruthy();
    expect(task.updatedAt).toBeTruthy();
  });

  it("is idempotent on external_id", async () => {
    const first = await testDb.tasks.create({
      externalId: "TASK-001",
      title: "t",
      description: "d",
      workspace: "/ws",
      maxReviewCycles: 3,
    });
    const second = await testDb.tasks.create({
      externalId: "TASK-001",
      title: "t",
      description: "d",
      workspace: "/ws",
      maxReviewCycles: 3,
    });

    expect(second.id).toBe(first.id);
    expect(await testDb.tasks.list()).toHaveLength(1);
  });

  it("finds a task by external id", async () => {
    await seedTask(testDb, { externalId: "TASK-FIND" });
    const found = await testDb.tasks.findByExternalId("TASK-FIND");
    expect(found?.externalId).toBe("TASK-FIND");
    expect(await testDb.tasks.findByExternalId("NOPE")).toBeUndefined();
  });
});

describe("atomic state transitions", () => {
  it("persists status AND an activity log together", async () => {
    const task = await seedTask(testDb);

    const outcome = await testDb.tasks.transition({
      taskId: task.id,
      eventId: "evt-1",
      to: "CODING",
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.task?.status).toBe("CODING");

    const reloaded = await testDb.tasks.findById(task.id);
    expect(reloaded?.status).toBe("CODING");

    // The activity row was written in the same transaction.
    const logs = await testDb.activityLogs.listForTask(task.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.eventType).toBe("STATE_CHANGED");
    expect(logs[0]!.payload).toMatchObject({ from: "PENDING", to: "CODING" });
  });

  it("walks the full CODING -> TESTING -> REVIEW -> APPROVED -> DONE path", async () => {
    const task = await seedTask(testDb);

    for (const [index, to] of (
      ["CODING", "TESTING", "REVIEW", "APPROVED", "DONE"] as TaskStatus[]
    ).entries()) {
      const outcome = await testDb.tasks.transition({
        taskId: task.id,
        eventId: `evt-${index}`,
        to,
        ...(to === "DONE" ? { patch: { approved: true, completedAt: new Date().toISOString() } } : {}),
      });
      expect(outcome.applied, `transition to ${to} failed: ${outcome.detail}`).toBe(true);
    }

    const done = await testDb.tasks.findById(task.id);
    expect(done?.status).toBe("DONE");
    expect(done?.approved).toBe(true);
    expect(done?.completedAt).toBeTruthy();
    expect(done?.transitionSeq).toBe(5);

    const logs = await testDb.activityLogs.listForTask(task.id);
    expect(logs.map((log) => log.eventType)).toEqual(Array(5).fill("STATE_CHANGED"));
  });

  it("walks the rejection loop REVIEW -> REJECTED -> FIXING -> TESTING -> REVIEW", async () => {
    const task = await seedTask(testDb);
    const steps: TaskStatus[] = ["CODING", "TESTING", "REVIEW", "REJECTED", "FIXING", "TESTING", "REVIEW"];

    for (const [index, to] of steps.entries()) {
      const outcome = await testDb.tasks.transition({
        taskId: task.id,
        eventId: `loop-${index}`,
        to,
      });
      expect(outcome.applied, `${to}: ${outcome.detail}`).toBe(true);
    }

    const final = await testDb.tasks.findById(task.id);
    expect(final?.status).toBe("REVIEW");
    expect(final?.transitionSeq).toBe(steps.length);
  });

  it("rejects an illegal transition and writes nothing", async () => {
    const task = await seedTask(testDb);

    const outcome = await testDb.tasks.transition({
      taskId: task.id,
      eventId: "evt-illegal",
      to: "DONE",
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.skipped).toBe("illegal-transition");

    const reloaded = await testDb.tasks.findById(task.id);
    expect(reloaded?.status).toBe("PENDING");
    expect(await testDb.activityLogs.countForTask(task.id)).toBe(0);
  });

  it("supports a policy stop that bypasses the state machine", async () => {
    const task = await seedTask(testDb);
    await testDb.tasks.transition({ taskId: task.id, eventId: "a", to: "CODING" });
    await testDb.tasks.transition({ taskId: task.id, eventId: "b", to: "TESTING" });
    await testDb.tasks.transition({ taskId: task.id, eventId: "c", to: "REVIEW" });

    // REVIEW -> NEEDS_HUMAN is not a machine edge; it is a policy decision.
    const withoutFlag = await testDb.tasks.transition({
      taskId: task.id,
      eventId: "d",
      to: "NEEDS_HUMAN",
    });
    expect(withoutFlag.applied).toBe(false);
    expect(withoutFlag.skipped).toBe("illegal-transition");

    const withFlag = await testDb.tasks.transition({
      taskId: task.id,
      eventId: "e",
      to: "NEEDS_HUMAN",
      reason: "MAX_REVIEW_CYCLES",
      allowUnlisted: true,
      patch: { stopReason: "MAX_REVIEW_CYCLES" },
    });
    expect(withFlag.applied).toBe(true);

    const reloaded = await testDb.tasks.findById(task.id);
    expect(reloaded?.status).toBe("NEEDS_HUMAN");
    expect(reloaded?.stopReason).toBe("MAX_REVIEW_CYCLES");
  });

  it("enforces the expected `from` state", async () => {
    const task = await seedTask(testDb);

    const outcome = await testDb.tasks.transition({
      taskId: task.id,
      eventId: "evt-mismatch",
      to: "CODING",
      from: "CODING",
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.skipped).toBe("status-mismatch");
    expect((await testDb.tasks.findById(task.id))?.status).toBe("PENDING");
  });
});

describe("idempotency", () => {
  it("ignores a duplicate event id", async () => {
    const task = await seedTask(testDb);

    const first = await testDb.tasks.transition({
      taskId: task.id,
      eventId: "evt-dup",
      to: "CODING",
    });
    const second = await testDb.tasks.transition({
      taskId: task.id,
      eventId: "evt-dup",
      to: "CODING",
    });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.skipped).toBe("duplicate-event");

    // Exactly one transition happened.
    const reloaded = await testDb.tasks.findById(task.id);
    expect(reloaded?.transitionSeq).toBe(1);
    expect(await testDb.activityLogs.countForTask(task.id)).toBe(1);
  });

  it("does not double-apply a duplicate event with a different target", async () => {
    const task = await seedTask(testDb);
    await testDb.tasks.transition({ taskId: task.id, eventId: "same", to: "CODING" });

    // Same event id, different target: still a no-op.
    const second = await testDb.tasks.transition({ taskId: task.id, eventId: "same", to: "TESTING" });

    expect(second.applied).toBe(false);
    expect(second.skipped).toBe("duplicate-event");
    expect((await testDb.tasks.findById(task.id))?.status).toBe("CODING");
  });

  it("ignores a duplicate in the activity log repository itself", async () => {
    const task = await seedTask(testDb);

    const first = await testDb.activityLogs.append({
      eventId: "log-1",
      taskId: task.id,
      eventType: "TOOL_STARTED",
      payload: { tool: "write_file" },
    });
    const second = await testDb.activityLogs.append({
      eventId: "log-1",
      taskId: task.id,
      eventType: "TOOL_STARTED",
      payload: { tool: "write_file" },
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await testDb.activityLogs.countForTask(task.id)).toBe(1);
  });
});

describe("concurrency", () => {
  it("only lets one claimant take a task", async () => {
    const task = await seedTask(testDb);

    const [a, b] = await Promise.all([
      testDb.tasks.claim({ taskId: task.id, eventId: "claim-a" }),
      testDb.tasks.claim({ taskId: task.id, eventId: "claim-b" }),
    ]);

    const winners = [a, b].filter((outcome) => outcome.claimed);
    const losers = [a, b].filter((outcome) => !outcome.claimed);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toBe("already-claimed");
    expect((await testDb.tasks.findById(task.id))?.status).toBe("CODING");
  });

  it("does not lose a concurrent transition when two callers race with the same expected state", async () => {
    const task = await seedTask(testDb);

    // Both callers believe the task is PENDING. `from` turns the transition into
    // a compare-and-set, so exactly one may win.
    const results = await Promise.all([
      testDb.tasks.transition({ taskId: task.id, eventId: "race-1", to: "CODING", from: "PENDING" }),
      testDb.tasks.transition({ taskId: task.id, eventId: "race-2", to: "CODING", from: "PENDING" }),
    ]);

    const applied = results.filter((result) => result.applied);
    const rejected = results.filter((result) => !result.applied);
    expect(applied).toHaveLength(1);
    expect(rejected[0]!.skipped).toBe("status-mismatch");

    const reloaded = await testDb.tasks.findById(task.id);
    expect(reloaded?.status).toBe("CODING");
    // One transition, one journal row: the row and the ledger agree.
    expect(reloaded?.transitionSeq).toBe(1);
    expect(await testDb.activityLogs.countForTask(task.id)).toBe(1);
  });

  it("serialises racing transitions so the ledger always matches the row", async () => {
    const task = await seedTask(testDb);

    // Without `from`, sequential calls are all legal (PENDING -> CODING ->
    // NEEDS_HUMAN). The invariant that must hold either way is consistency:
    // transition_seq equals the number of applied transitions and the journal
    // agrees with it.
    const results = await Promise.all([
      testDb.tasks.transition({ taskId: task.id, eventId: "seq-1", to: "CODING" }),
      testDb.tasks.transition({
        taskId: task.id,
        eventId: "seq-2",
        to: "NEEDS_HUMAN",
        allowUnlisted: true,
      }),
    ]);

    const appliedCount = results.filter((result) => result.applied).length;
    const reloaded = await testDb.tasks.findById(task.id);

    expect(reloaded?.transitionSeq).toBe(appliedCount);
    expect(await testDb.activityLogs.countForTask(task.id)).toBe(appliedCount);
    // If both applied, the second one observed the first one's commit, which
    // proves the write really was serialised and not lost.
    if (appliedCount === 2) {
      expect(reloaded?.status).toBe("NEEDS_HUMAN");
    }
  });

  it("refuses to claim a task that is already terminal", async () => {
    const task = await seedTask(testDb);
    await testDb.tasks.transition({
      taskId: task.id,
      eventId: "t1",
      to: "CODING",
      patch: { assignedAgentId: null },
    });
    await testDb.tasks.transition({ taskId: task.id, eventId: "t2", to: "TESTING" });
    await testDb.tasks.transition({ taskId: task.id, eventId: "t3", to: "REVIEW" });
    await testDb.tasks.transition({
      taskId: task.id,
      eventId: "t4",
      to: "NEEDS_HUMAN",
      allowUnlisted: true,
    });

    const claim = await testDb.tasks.claim({ taskId: task.id, eventId: "claim-late" });
    expect(claim.claimed).toBe(false);
    expect(claim.reason).toBe("terminal");
  });

  it("prevents two reviewers from deciding the same cycle", async () => {
    const task = await seedTask(testDb);

    const save = () =>
      testDb.reviews.save({
        taskId: task.id,
        reviewer: "reviewer-agent",
        cycle: 1,
        verdict: "REJECTED",
        severity: "MEDIUM",
        summary: "issues found",
        issues: ["x"],
        requiredFixes: ["fix x"],
      });

    const first = await save();

    // A second decision for the same cycle must not be recorded. It is a no-op
    // rather than an error: re-running a cycle (retry, restart) is normal, and
    // raising here aborted an approved task as unhealthy persistence.
    const second = await save();
    expect(second.id).toBe(first.id);
    expect(second.verdict).toBe("REJECTED");
    expect(await testDb.reviews.listForTask(task.id)).toHaveLength(1);
    expect(first.cycle).toBe(1);
  });

  it("does not overwrite an existing review with a different verdict", async () => {
    const task = await seedTask(testDb);
    const base = {
      taskId: task.id,
      reviewer: "reviewer-agent",
      cycle: 1,
      severity: "NONE" as const,
      summary: "first",
      issues: [] as string[],
      requiredFixes: [] as string[],
    };

    await testDb.reviews.save({ ...base, verdict: "REJECTED" });
    const second = await testDb.reviews.save({ ...base, verdict: "APPROVED", summary: "second" });

    // The first decision stands: review history is append-only.
    expect(second.verdict).toBe("REJECTED");
    expect(second.summary).toBe("first");
    expect(await testDb.reviews.listForTask(task.id)).toHaveLength(1);
  });
});

describe("transition table vs the domain state machine", () => {
  const states: TaskState[] = [
    "PENDING",
    "CODING",
    "TESTING",
    "REVIEW",
    "REJECTED",
    "FIXING",
    "APPROVED",
    "DONE",
    "NEEDS_HUMAN",
  ];

  /** States only the persistence layer knows about (not domain states). */
  const PERSISTENCE_ONLY_TARGETS: readonly TaskStatus[] = ["NEEDS_HUMAN", "CANCELLED"];

  it("never drops a domain edge", () => {
    for (const from of states) {
      for (const to of states) {
        if (domainCanTransition(from, to)) {
          expect(
            knownTransition(from, to),
            `the persisted table lost the domain edge ${from} -> ${to}`,
          ).toBe(true);
        }
      }
    }
  });

  it("only ADDS policy-stop and resume edges", () => {
    const extra: string[] = [];
    for (const from of Object.keys(PERSISTED_TRANSITION_TABLE)) {
      for (const to of PERSISTED_TRANSITION_TABLE[from] ?? []) {
        const isDomainPair =
          (states as string[]).includes(from) && (states as string[]).includes(to);
        const domainAllows = isDomainPair && domainCanTransition(from as TaskState, to as TaskState);
        if (domainAllows || from === to) continue;

        extra.push(`${from} -> ${to}`);
        const isPolicyStop = PERSISTENCE_ONLY_TARGETS.includes(to);
        const isResume = from === "PAUSED";
        expect(
          isPolicyStop || isResume,
          `${from} -> ${to} is neither a domain edge, a policy stop, nor a resume`,
        ).toBe(true);
      }
    }
    // Sanity: there really are extra edges, and they are accounted for.
    expect(extra.length).toBeGreaterThan(0);
    expect(
      extra.every((edge) => /NEEDS_HUMAN|CANCELLED/.test(edge) || edge.startsWith("PAUSED ->")),
    ).toBe(true);
  });

  it("has PAUSED and CANCELLED as the only persistence-only states", () => {
    const extra = Object.keys(PERSISTED_TRANSITION_TABLE).filter(
      (state) => !(states as string[]).includes(state),
    );
    expect(extra.sort()).toEqual(["CANCELLED", "PAUSED"]);
  });
});

describe("TaskRepository.release", () => {
  it("clears the assignment without pretending the task finished", async () => {
    const { coderId } = await seedAgents(testDb);
    const task = await seedTask(testDb);
    await testDb.tasks.claim({ taskId: task.id, agentId: coderId, eventId: "c1" });

    const released = await testDb.tasks.release({ taskId: task.id, reason: "worker crashed" });

    expect(released?.assignedAgentId).toBeUndefined();
    expect(released?.status).toBe("CODING");
    expect(released?.completedAt).toBeUndefined();
  });
});
