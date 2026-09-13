/**
 * Task persistence.
 *
 * The important method is `transition`. A state change and its audit entry are
 * written in ONE transaction, and the transition is idempotent on the event id:
 *
 *   1. the task row is locked (`select … for update`)
 *   2. a duplicate `event_id` in activity_logs short-circuits to a no-op
 *   3. the transition is validated against the state machine's transition table
 *      unless the caller overrides it for a policy stop
 *   4. tasks.status + transition_seq are updated with a compare-and-set on the
 *      sequence we observed, so a concurrent writer cannot silently win
 *   5. the STATE_CHANGED activity row is inserted with that event id
 *
 * Steps 4 and 5 are in the same transaction, which is what makes "task.status =
 * TESTING and an activity log" all-or-nothing.
 */

import type { Db, UnitOfWork } from "../db.js";
import { Repository, withDbRetry } from "../db.js";
import { asBoolean, asIso, asNullableIso, asNullableString, asNumber, asString, requireRow, type Row } from "../rows.js";
import type { TaskStatus } from "../../events/types.js";

export interface TaskRecord {
  id: string;
  externalId: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedAgentId?: string;
  workspace: string;
  currentCycle: number;
  maxReviewCycles: number;
  stopReason?: string;
  approved: boolean;
  transitionSeq: number;
  /** Status the task held when it was paused; null when not paused. */
  resumeStatus?: TaskStatus;
  /**
   * Last worker liveness signal. A non-terminal task whose heartbeat stopped is
   * owned by a process that died (PHASE 6 stale detection).
   */
  heartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  currentPhase?: string;
  recoveryMetadata?: Record<string, unknown>;
}

export interface CreateTaskInput {
  externalId: string;
  title: string;
  description: string;
  workspace: string;
  maxReviewCycles: number;
  /** Raw spec, stored as given (acceptance criteria included). */
  spec?: Record<string, unknown>;
  /** Idempotency key: a repeated create with the same external id is a no-op. */
  eventId?: string;
  assignedAgentId?: string;
  now?: string;
}

export interface TransitionInput {
  taskId: string;
  /** The event that caused it — also the idempotency key. */
  eventId: string;
  to: TaskStatus;
  /** Expected current status; when supplied, a mismatch aborts the transition. */
  from?: TaskStatus;
  cycle?: number;
  reason?: string;
  occurredAt?: string;
  agentId?: string;
  runId?: string;
  /**
   * Allows a transition the state machine rejects (policy stops such as
   * budget exhaustion). Off by default so a typo cannot silently bypass the
   * machine.
   */
  allowUnlisted?: boolean;
  /** Extra fields applied in the same statement. */
  patch?: {
    stopReason?: string | null;
    approved?: boolean;
    assignedAgentId?: string | null;
    completedAt?: string | null;
    startedAt?: string | null;
    currentCycle?: number;
  };
}

export interface TransitionOutcome {
  /** True when this call performed the change; false when it was a no-op. */
  applied: boolean;
  /** Why it was not applied. */
  skipped?: "duplicate-event" | "status-mismatch" | "illegal-transition" | "not-found";
  task?: TaskRecord;
  detail?: string;
}

/** Claims are the concurrency primitive: only one worker can hold a task. */
export interface ClaimOutcome {
  claimed: boolean;
  task?: TaskRecord;
  reason?: "already-claimed" | "not-found" | "terminal";
}

export interface TaskRepository {
  predictNextExternalId(): Promise<string>;
  createAuto(input: Omit<CreateTaskInput, "externalId">): Promise<TaskRecord>;
  create(input: CreateTaskInput): Promise<TaskRecord>;
  findById(id: string): Promise<TaskRecord | undefined>;
  findByExternalId(externalId: string): Promise<TaskRecord | undefined>;
  list(options?: { status?: TaskStatus[]; limit?: number }): Promise<TaskRecord[]>;
  transition(input: TransitionInput): Promise<TransitionOutcome>;
  /** Atomic PENDING -> CODING claim. Fails when another worker owns the task. */
  claim(input: { taskId: string; agentId?: string; eventId: string; cycle?: number }): Promise<ClaimOutcome>;
  /** Releases a claim without pretending the task finished. */
  release(input: { taskId: string; to?: TaskStatus; reason: string }): Promise<TaskRecord | undefined>;
  /**
   * Sets a persistence-level status (PAUSED / CANCELLED / re-queue) that the
   * domain state machine does not model. The previous status is remembered in
   * `resume_status` so RESUME can return to exactly where it left off.
   */
  setStatus(
    taskId: string,
    status: TaskStatus,
    options?: {
      fromStatus?: TaskStatus;
      transitionSeqBump?: boolean;
      clearStopReason?: boolean;
      clearApproval?: boolean;
      clearCompletion?: boolean;
    },
  ): Promise<TaskRecord | undefined>;
  updateCheckpoint(
    taskId: string,
    currentPhase: string,
    recoveryMetadata?: Record<string, unknown>
  ): Promise<void>;
  touch(taskId: string): Promise<void>;
  /**
   * Records worker liveness for a task mid-run.
   *
   * Without this, "is this task still being worked on?" could only be inferred
   * from started_at — wrong for a legitimately long run. The heartbeat is what
   * makes stale detection honest (PHASE 6).
   */
  heartbeat(taskId: string): Promise<void>;
  /**
   * Tasks that a worker should be running but is not: non-terminal status with a
   * heartbeat that stopped (or that never arrived).
   *
   * Deletion is never automatic — this only reports.
   */
  listStale(options?: { olderThanMs?: number; limit?: number }): Promise<TaskRecord[]>;
  /** Row counts per status, for the board's header counters. */
  countsByStatus(): Promise<Record<string, number>>;
  /** Per-agent outcome counters, derived from stored rows only. */
  statsForAgent(agentId: string): Promise<{ total: number; completed: number; failed: number; active: number }>;
}

export function mapTask(row: Row): TaskRecord {
  return {
    id: asString(row.id),
    externalId: asString(row.external_id),
    title: asString(row.title),
    description: asString(row.description),
    status: asString(row.status) as TaskStatus,
    ...(asNullableString(row.assigned_agent_id)
      ? { assignedAgentId: asNullableString(row.assigned_agent_id)! }
      : {}),
    workspace: asString(row.workspace),
    currentCycle: asNumber(row.current_cycle),
    maxReviewCycles: asNumber(row.max_review_cycles, 3),
    ...(asNullableString(row.stop_reason) ? { stopReason: asNullableString(row.stop_reason)! } : {}),
    approved: asBoolean(row.approved),
    transitionSeq: asNumber(row.transition_seq),
    ...(asNullableString(row.resume_status)
      ? { resumeStatus: asNullableString(row.resume_status) as TaskStatus }
      : {}),
    ...(asNullableIso(row.heartbeat_at) ? { heartbeatAt: asNullableIso(row.heartbeat_at)! } : {}),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    ...(asNullableIso(row.started_at) ? { startedAt: asNullableIso(row.started_at)! } : {}),
    ...(asNullableIso(row.completed_at) ? { completedAt: asNullableIso(row.completed_at)! } : {}),
    ...(asNullableString(row.current_phase) ? { currentPhase: asNullableString(row.current_phase)! } : {}),
    ...(row.recovery_metadata ? { recoveryMetadata: row.recovery_metadata as Record<string, unknown> } : {}),
  };
}

export class PostgresTaskRepository extends Repository implements TaskRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        const rows = await tx.query(
          `insert into tasks (external_id, title, description, workspace, max_review_cycles,
                              status, assigned_agent_id, created_at)
           values ($1, $2, $3, $4, $5, 'PENDING', $6, coalesce($7::timestamptz, now()))
           on conflict (external_id) do update
             set updated_at = now()
           returning *`,
          [
            input.externalId,
            input.title,
            input.description,
            input.workspace,
            input.maxReviewCycles,
            input.assignedAgentId ?? null,
            input.now ?? null,
          ],
        );
        return mapTask(requireRow(rows, "task.create"));
      }),
    );
  }

  async predictNextExternalId(): Promise<string> {
    const rows = await this.tx().query(
      `SELECT 'TASK-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(external_id, '^TASK-0*', ''), '')::integer), 0) + 1)::text, 3, '0') AS val
       FROM tasks
       WHERE external_id ~ '^TASK-\\d+$'`
    );
    return asString(rows[0]?.val ?? "TASK-001");
  }

  async createAuto(input: Omit<CreateTaskInput, "externalId">): Promise<TaskRecord> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        // Use an advisory lock to serialize auto-ID allocation globally
        await tx.query("SELECT pg_advisory_xact_lock(7456)");
        const rows = await tx.query(
          `
          WITH next_id AS (
            SELECT 'TASK-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(external_id, '^TASK-0*', ''), '')::integer), 0) + 1)::text, 3, '0') AS val
            FROM tasks
            WHERE external_id ~ '^TASK-\\d+$'
          )
          INSERT INTO tasks (external_id, title, description, workspace, max_review_cycles,
                             status, assigned_agent_id, created_at)
          SELECT next_id.val, $1, $2, $3, $4, 'PENDING', $5, coalesce($6::timestamptz, now())
          FROM next_id
          RETURNING *
          `,
          [
            input.title,
            input.description,
            input.workspace,
            input.maxReviewCycles,
            input.assignedAgentId ?? null,
            input.now ?? null,
          ]
        );
        return mapTask(requireRow(rows, "task.createAuto"));
      })
    );
  }

  async findById(id: string): Promise<TaskRecord | undefined> {
    const rows = await this.tx().query("select * from tasks where id = $1", [id]);
    return rows[0] ? mapTask(rows[0]) : undefined;
  }

  async findByExternalId(externalId: string): Promise<TaskRecord | undefined> {
    const rows = await this.tx().query("select * from tasks where external_id = $1", [externalId]);
    return rows[0] ? mapTask(rows[0]) : undefined;
  }

  async list(options: { status?: TaskStatus[]; limit?: number } = {}): Promise<TaskRecord[]> {
    const limit = options.limit ?? 100;
    if (options.status?.length) {
      const rows = await this.tx().query(
        "select * from tasks where status = any($1) order by created_at desc limit $2",
        [options.status, limit],
      );
      return rows.map(mapTask);
    }
    const rows = await this.tx().query("select * from tasks order by created_at desc limit $1", [
      limit,
    ]);
    return rows.map(mapTask);
  }

  /**
   * The atomic state change. See the file header for the exact ordering.
   *
   * Validation uses the DOMAIN state machine (single source of truth) for the
   * domain states, and the persisted table for the persistence-only states
   * (PAUSED / CANCELLED). `allowUnlisted` is for policy stops — a transition the
   * machine rejects but the orchestrator chooses to record, such as budget
   * exhaustion moving REVIEW -> NEEDS_HUMAN.
   */
  async transition(input: TransitionInput): Promise<TransitionOutcome> {
    const { canTransition: machineAllows } = await import("../../domain/task-machine.js");

    const isLegal = (from: TaskStatus, to: TaskStatus): boolean => {
      if (from === to) return true;
      if (isMachineState(from) && isMachineState(to)) return machineAllows(from, to);
      return knownTransition(from, to);
    };

    return withDbRetry(async () =>
      this.run(async (tx) => {
        // Serialise all writers for this task. Released automatically at commit
        // or rollback, so a crashed writer cannot leave the task locked.
        await tx.advisoryLock(`task:${input.taskId}`);

        // Idempotency first: a redelivered event must not move anything.
        const seen = await tx.query<{ event_id: string }>(
          "select event_id from activity_logs where event_id = $1",
          [input.eventId],
        );
        if (seen.length > 0) {
          const task = await this.findByIdWithin(tx, input.taskId);
          return { applied: false, skipped: "duplicate-event", ...(task ? { task } : {}) };
        }

        const locked = await tx.query("select * from tasks where id = $1 for update", [
          input.taskId,
        ]);
        const current = locked[0];
        if (!current) return { applied: false, skipped: "not-found" };

        const currentTask = mapTask(current);

        if (input.from !== undefined && currentTask.status !== input.from) {
          return {
            applied: false,
            skipped: "status-mismatch",
            task: currentTask,
            detail: `expected ${input.from} but the task is in ${currentTask.status}`,
          };
        }

        if (!isLegal(currentTask.status, input.to) && !input.allowUnlisted) {
          return {
            applied: false,
            skipped: "illegal-transition",
            task: currentTask,
            detail: `${currentTask.status} -> ${input.to} is not a legal transition`,
          };
        }

        const patch = input.patch ?? {};
        const rows = await tx.query(
          `update tasks
              set status = $2,
                  transition_seq = transition_seq + 1,
                  current_cycle = coalesce($3::int, current_cycle),
                  stop_reason = case when $4::boolean then $5::text else stop_reason end,
                  approved = coalesce($6::boolean, approved),
                  assigned_agent_id = case when $7::boolean then $8::uuid else assigned_agent_id end,
                  started_at = case when $9::boolean then $10::timestamptz else started_at end,
                  completed_at = case when $11::boolean then $12::timestamptz else completed_at end
            where id = $1
        returning *`,
          [
            input.taskId,
            input.to,
            input.cycle ?? null,
            "stopReason" in patch,
            patch.stopReason ?? null,
            "approved" in patch ? patch.approved : null,
            "assignedAgentId" in patch,
            patch.assignedAgentId ?? null,
            "startedAt" in patch,
            patch.startedAt ?? null,
            "completedAt" in patch,
            patch.completedAt ?? null,
          ],
        );

        const updated = mapTask(requireRow(rows, "task.transition"));

        // Same transaction as the status change: they can never diverge.
        await tx.query(
          `insert into activity_logs (event_id, task_id, agent_id, event_type, cycle, payload, occurred_at)
           values ($1, $2, $3, 'STATE_CHANGED', $4, $5::jsonb, coalesce($6::timestamptz, now()))
           on conflict (event_id) do nothing`,
          [
            input.eventId,
            input.taskId,
            input.agentId ?? null,
            input.cycle ?? updated.currentCycle,
            JSON.stringify({
              from: currentTask.status,
              to: input.to,
              cycle: input.cycle ?? updated.currentCycle,
              ...(input.reason ? { reason: input.reason } : {}),
            }),
            input.occurredAt ?? null,
          ],
        );

        return { applied: true, task: updated };
      }),
    );
  }

  async claim(input: {
    taskId: string;
    agentId?: string;
    eventId: string;
    cycle?: number;
  }): Promise<ClaimOutcome> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        await tx.advisoryLock(`task:${input.taskId}`);

        const rows = await tx.query("select * from tasks where id = $1 for update", [input.taskId]);
        const current = rows[0];
        if (!current) return { claimed: false, reason: "not-found" };

        const task = mapTask(current);
        if (isTerminalStatus(task.status)) return { claimed: false, reason: "terminal", task };
        if (task.status !== "PENDING") return { claimed: false, reason: "already-claimed", task };

        const updated = await tx.query(
          `update tasks
              set status = 'CODING',
                  assigned_agent_id = coalesce($2::uuid, assigned_agent_id),
                  started_at = coalesce(started_at, now()),
                  transition_seq = transition_seq + 1,
                  current_cycle = 1
            where id = $1 and status = 'PENDING'
        returning *`,
          [input.taskId, input.agentId ?? null],
        );

        if (updated.length === 0) {
          // Lost the compare-and-set: another writer moved it first.
          const fresh = await this.findByIdWithin(tx, input.taskId);
          return { claimed: false, reason: "already-claimed", ...(fresh ? { task: fresh } : {}) };
        }

        const claimedTask = mapTask(updated[0]!);
        await tx.query(
          `insert into activity_logs (event_id, task_id, agent_id, event_type, cycle, payload, occurred_at)
           values ($1, $2, $3, 'STATE_CHANGED', 1, $4::jsonb, now())
           on conflict (event_id) do nothing`,
          [
            input.eventId,
            input.taskId,
            input.agentId ?? null,
            JSON.stringify({ from: "PENDING", to: "CODING", cycle: 1, reason: "claimed" }),
          ],
        );

        return { claimed: true, task: claimedTask };
      }),
    );
  }

  async release(input: {
    taskId: string;
    to?: TaskStatus;
    reason: string;
  }): Promise<TaskRecord | undefined> {
    return this.run(async (tx) => {
      await tx.advisoryLock(`task:${input.taskId}`);
      const rows = await tx.query(
        `update tasks
            set status = coalesce($2, status),
                assigned_agent_id = null,
                transition_seq = transition_seq + 1
          where id = $1
      returning *`,
        [input.taskId, input.to ?? null],
      );
      return rows[0] ? mapTask(rows[0]) : undefined;
    });
  }

  async updateCheckpoint(
    taskId: string,
    currentPhase: string,
    recoveryMetadata?: Record<string, unknown>
  ): Promise<void> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        await tx.query(
          `update tasks
           set current_phase = $2,
               recovery_metadata = coalesce($3::jsonb, recovery_metadata),
               updated_at = now()
           where id = $1`,
          [taskId, currentPhase, recoveryMetadata ? JSON.stringify(recoveryMetadata) : null],
        );
      }),
    );
  }

  async touch(taskId: string): Promise<void> {
    await this.tx().query("update tasks set updated_at = now() where id = $1", [taskId]);
  }

  /**
   * Liveness ping. Deliberately touches only `heartbeat_at`: it must not bump
   * updated_at, or a stuck-but-alive worker would look "updated" forever and
   * the dashboard's "updated" column would stop meaning "a human/agent act".
   */
  async heartbeat(taskId: string): Promise<void> {
    await this.tx().query("update tasks set heartbeat_at = now() where id = $1", [taskId]);
  }

  /**
   * Non-terminal tasks whose worker stopped signalling.
   *
   * A task with NO heartbeat at all is stale once it has been in flight for the
   * threshold — that covers a worker that died before its first ping.
   */
  async listStale(options: { olderThanMs?: number; limit?: number } = {}): Promise<TaskRecord[]> {
    const threshold = Math.max(0, Math.trunc(options.olderThanMs ?? 0));
    const limit = options.limit ?? 100;
    const rows = await this.tx().query(
      `select * from tasks
        where status in ('CODING', 'TESTING', 'REVIEW', 'FIXING', 'REJECTED')
          and coalesce(heartbeat_at, started_at, created_at) < now() - ($1::int * interval '1 millisecond')
        order by coalesce(heartbeat_at, started_at, created_at) asc
        limit $2`,
      [threshold, limit],
    );
    return rows.map(mapTask);
  }

  /**
   * Persistence-level status change (PAUSED / CANCELLED / PENDING re-queue).
   *
   * `resume_status` records what the task was doing so RESUME restores the real
   * state instead of guessing. When pausing, the current status is captured;
   * when leaving PAUSED, it is cleared.
   */
    async setStatus(
      taskId: string,
      status: TaskStatus,
      options: {
        fromStatus?: TaskStatus;
        rejectStatuses?: TaskStatus[];
        transitionSeqBump?: boolean;
        clearStopReason?: boolean;
        clearApproval?: boolean;
        clearCompletion?: boolean;
      } = {},
    ): Promise<TaskRecord | undefined> {
      return withDbRetry(async () =>
        this.run(async (tx) => {
          await tx.advisoryLock(`task:${taskId}`);
          const locked = await tx.query("select * from tasks where id = $1 for update", [taskId]);
          const current = locked[0];
          if (!current) return undefined;
  
          const currentTask = mapTask(current);
          if (options.fromStatus !== undefined && currentTask.status !== options.fromStatus) {
            return undefined;
          }

          if (options.rejectStatuses && options.rejectStatuses.includes(currentTask.status)) {
            return undefined;
          }

        // Capturing / clearing the resume target.
        const capturingResume = status === "PAUSED" && currentTask.status !== "PAUSED";
        const resuming = options.fromStatus === "PAUSED" && status !== "PAUSED";

        const rows = await tx.query(
          `update tasks
              set status = $2,
                  transition_seq = transition_seq + $3::int,
                  resume_status = case
                    when $4::boolean then $5::text
                    when $6::boolean then null
                    else resume_status
                  end,
                  stop_reason = case when $7::boolean then null else stop_reason end,
                  approved = case when $8::boolean then false else approved end,
                  completed_at = case when $9::boolean then null else completed_at end
            where id = $1
        returning *`,
          [
            taskId,
            status,
            options.transitionSeqBump === false ? 0 : 1,
            capturingResume,
            currentTask.status,
            resuming,
            options.clearStopReason === true,
            options.clearApproval === true,
            options.clearCompletion === true,
          ],
        );

        const updated = mapTask(requireRow(rows, "task.setStatus"));

        // Journalled with the transition, like the domain transitions are.
        const eventId = `dash:${taskId}:${updated.transitionSeq}`;
        await tx.query(
          `insert into activity_logs (event_id, task_id, event_type, cycle, payload, occurred_at)
           values ($1, $2, 'STATE_CHANGED', $3, $4::jsonb, now())
           on conflict (event_id) do nothing`,
          [
            eventId,
            taskId,
            updated.currentCycle,
            JSON.stringify({
              from: currentTask.status,
              to: status,
              cycle: updated.currentCycle,
              reason: "dashboard:status",
            }),
          ],
        );

        return updated;
      }),
    );
  }

  async countsByStatus(): Promise<Record<string, number>> {
    const rows = await this.tx().query<{ status: string; n: string }>(
      "select status, count(*)::text as n from tasks group by status",
    );
    return Object.fromEntries(rows.map((row) => [asString(row.status), asNumber(row.n)]));
  }

  /**
   * Counters for an agent detail page.
   *
   * Everything is derived from stored rows: `completed` means the task reached
   * DONE, `failed` means NEEDS_HUMAN/CANCELLED, `active` means it is in flight.
   * Nothing here is estimated or invented.
   */
  async statsForAgent(
    agentId: string,
  ): Promise<{ total: number; completed: number; failed: number; active: number }> {
    const rows = await this.tx().query<{ total: string; completed: string; failed: string; active: string }>(
      `select
         count(*)::text as total,
         count(*) filter (where status = 'DONE')::text as completed,
         count(*) filter (where status in ('NEEDS_HUMAN', 'CANCELLED'))::text as failed,
         count(*) filter (where status not in ('DONE', 'NEEDS_HUMAN', 'CANCELLED'))::text as active
       from tasks
       where assigned_agent_id = $1`,
      [agentId],
    );
    const row = rows[0];
    return {
      total: asNumber(row?.total, 0),
      completed: asNumber(row?.completed, 0),
      failed: asNumber(row?.failed, 0),
      active: asNumber(row?.active, 0),
    };
  }

  private async findByIdWithin(tx: UnitOfWork, id: string): Promise<TaskRecord | undefined> {
    const rows = await tx.query("select * from tasks where id = $1", [id]);
    return rows[0] ? mapTask(rows[0]) : undefined;
  }
}

const MACHINE_STATES: readonly TaskStatus[] = [
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

/** The subset of states that exist in the domain state machine. */
export type MachineState = Extract<
  TaskStatus,
  | "PENDING"
  | "CODING"
  | "TESTING"
  | "REVIEW"
  | "REJECTED"
  | "FIXING"
  | "APPROVED"
  | "DONE"
  | "NEEDS_HUMAN"
>;

export function isMachineState(status: TaskStatus): status is MachineState {
  return (MACHINE_STATES as readonly string[]).includes(status);
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "DONE" || status === "NEEDS_HUMAN" || status === "CANCELLED";
}

/**
 * Local mirror of the allowed edges, used for validation inside the SQL
 * transaction without importing the domain module on every call.
 * Kept in sync by a unit test that compares it with the state machine.
 */
const PERSISTED_TRANSITIONS: Readonly<Record<string, readonly TaskStatus[]>> = {
  PENDING: ["CODING", "NEEDS_HUMAN", "CANCELLED"],
  CODING: ["TESTING", "NEEDS_HUMAN", "CANCELLED"],
  TESTING: ["REVIEW", "NEEDS_HUMAN", "CANCELLED"],
  REVIEW: ["APPROVED", "REJECTED", "NEEDS_HUMAN", "CANCELLED"],
  REJECTED: ["FIXING", "NEEDS_HUMAN", "CANCELLED"],
  FIXING: ["TESTING", "NEEDS_HUMAN", "CANCELLED"],
  APPROVED: ["DONE", "NEEDS_HUMAN", "CANCELLED"],
  DONE: [],
  NEEDS_HUMAN: [],
  PAUSED: ["CODING", "TESTING", "REVIEW", "FIXING", "CANCELLED"],
  CANCELLED: [],
};

export function knownTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (PERSISTED_TRANSITIONS[from] ?? []).includes(to);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = PERSISTED_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/** Exposed for the test that keeps this table in sync with the domain machine. */
export const PERSISTED_TRANSITION_TABLE = PERSISTED_TRANSITIONS;
