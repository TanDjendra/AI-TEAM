/**
 * Run persistence.
 *
 * A "run" is one execution of a task by the orchestrator. `run_id` is the
 * idempotency anchor for everything produced during that execution, and its
 * status is how a crashed process is detected later (RUNNING with no live
 * worker => INTERRUPTED).
 */

import type { Db, UnitOfWork } from "../db.js";
import { Repository, withDbRetry } from "../db.js";
import {
  asIso,
  asNullableIso,
  asNullableString,
  asNumber,
  asString,
  requireRow,
  type Row,
} from "../rows.js";

export type RunStatus = "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED" | "CANCELLED";

export interface RunRecord {
  id: string;
  taskId: string;
  runId: string;
  status: RunStatus;
  agentId?: string;
  cycle: number;
  reason?: string;
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
  recoveryMetadata?: Record<string, unknown>;
}

export interface StartRunInput {
  taskId: string;
  runId: string;
  agentId?: string;
  cycle?: number;
  reason?: string;
}

export interface RunRepository {
  start(input: StartRunInput): Promise<RunRecord>;
  findById(id: string): Promise<RunRecord | undefined>;
  findByRunId(runId: string): Promise<RunRecord | undefined>;
  /** Most recent run for a task. */
  latestForTask(taskId: string): Promise<RunRecord | undefined>;
  listForTask(taskId: string): Promise<RunRecord[]>;
  finish(input: {
    runId: string;
    status: Exclude<RunStatus, "RUNNING">;
    stopReason?: string;
    totalTokens?: number;
  }): Promise<RunRecord | undefined>;
  updateCheckpoint(runId: string, recoveryMetadata: Record<string, unknown>): Promise<void>;
  addTokens(runId: string, tokens: number): Promise<void>;
  /** Runs still marked RUNNING — the recovery sweep input. */
  listStale(olderThanMs?: number): Promise<RunRecord[]>;
}

export function mapRun(row: Row): RunRecord {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    runId: asString(row.run_id),
    status: asString(row.status) as RunStatus,
    ...(asNullableString(row.agent_id) ? { agentId: asNullableString(row.agent_id)! } : {}),
    cycle: asNumber(row.cycle),
    ...(asNullableString(row.reason) ? { reason: asNullableString(row.reason)! } : {}),
    ...(asNullableString(row.stop_reason) ? { stopReason: asNullableString(row.stop_reason)! } : {}),
    startedAt: asIso(row.started_at),
    ...(asNullableIso(row.finished_at) ? { finishedAt: asNullableIso(row.finished_at)! } : {}),
    ...(row.duration_ms === null || row.duration_ms === undefined
      ? {}
      : { durationMs: asNumber(row.duration_ms) }),
    totalTokens: asNumber(row.total_tokens),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    ...(row.recovery_metadata ? { recoveryMetadata: row.recovery_metadata as Record<string, unknown> } : {}),
  };
}

export class PostgresRunRepository extends Repository implements RunRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  /** Idempotent on `run_id`: re-starting the same run returns the original row. */
  async start(input: StartRunInput): Promise<RunRecord> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        const rows = await tx.query(
          `insert into task_runs (task_id, run_id, agent_id, cycle, reason, status)
           values ($1, $2, $3, $4, $5, 'RUNNING')
           on conflict (run_id) do update
             set updated_at = now()
           returning *`,
          [input.taskId, input.runId, input.agentId ?? null, input.cycle ?? 0, input.reason ?? null],
        );
        return mapRun(requireRow(rows, "run.start"));
      }),
    );
  }

  async findById(id: string): Promise<RunRecord | undefined> {
    const rows = await this.tx().query("select * from task_runs where id = $1", [id]);
    return rows[0] ? mapRun(rows[0]) : undefined;
  }

  async findByRunId(runId: string): Promise<RunRecord | undefined> {
    const rows = await this.tx().query("select * from task_runs where run_id = $1", [runId]);
    return rows[0] ? mapRun(rows[0]) : undefined;
  }

  async latestForTask(taskId: string): Promise<RunRecord | undefined> {
    const rows = await this.tx().query(
      "select * from task_runs where task_id = $1 order by started_at desc limit 1",
      [taskId],
    );
    return rows[0] ? mapRun(rows[0]) : undefined;
  }

  async listForTask(taskId: string): Promise<RunRecord[]> {
    const rows = await this.tx().query(
      "select * from task_runs where task_id = $1 order by started_at asc",
      [taskId],
    );
    return rows.map(mapRun);
  }

  async finish(input: {
    runId: string;
    status: Exclude<RunStatus, "RUNNING">;
    stopReason?: string;
    totalTokens?: number;
  }): Promise<RunRecord | undefined> {
    return this.run(async (tx) => {
      const rows = await tx.query(
        `update task_runs
            set status = $2,
                stop_reason = coalesce($3::text, stop_reason),
                total_tokens = coalesce($4::int, total_tokens),
                finished_at = now(),
                duration_ms = greatest(0, (extract(epoch from (now() - started_at)) * 1000))::int
          where run_id = $1
      returning *`,
        [input.runId, input.status, input.stopReason ?? null, input.totalTokens ?? null],
      );
      return rows[0] ? mapRun(rows[0]) : undefined;
    });
  }

  async updateCheckpoint(runId: string, recoveryMetadata: Record<string, unknown>): Promise<void> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        await tx.query(
          `update task_runs
           set recovery_metadata = coalesce($2::jsonb, recovery_metadata),
               updated_at = now()
           where run_id = $1`,
          [runId, JSON.stringify(recoveryMetadata)],
        );
      }),
    );
  }

  async addTokens(runId: string, tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    await this.tx().query(
      "update task_runs set total_tokens = total_tokens + $2 where run_id = $1",
      [runId, Math.trunc(tokens)],
    );
  }

  /**
   * Runs still marked RUNNING. Anything older than `olderThanMs` is considered
   * abandoned: the process that owned it is gone.
   */
  async listStale(olderThanMs = 0): Promise<RunRecord[]> {
    const rows = await this.tx().query(
      `select * from task_runs
        where status = 'RUNNING'
          and started_at < now() - ($1::int * interval '1 millisecond')
        order by started_at asc`,
      [Math.max(0, Math.trunc(olderThanMs))],
    );
    return rows.map(mapRun);
  }
}
