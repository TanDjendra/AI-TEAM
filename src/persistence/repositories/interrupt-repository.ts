/**
 * Cooperative-interrupt persistence.
 *
 * A pause/cancel request is a *request*, not a state change: the worker that
 * owns the task must observe it and unwind at a safe point. Storing it in the
 * database (rather than a process-local flag) is what makes the control work
 * across processes and across a restart — and it is why the task is not marked
 * PAUSED until the worker confirms.
 */

import type { Db, UnitOfWork } from "../db.js";
import { Repository } from "../db.js";
import { asIso, asNullableIso, asString, requireRow, type Row } from "../rows.js";

export type InterruptIntent = "pause" | "cancel";

export interface InterruptRecord {
  id: string;
  taskId: string;
  intent: InterruptIntent;
  reason: string;
  actor: string;
  requestedAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
}

export interface RequestInterruptInput {
  taskId: string;
  intent: InterruptIntent;
  reason: string;
  actor?: string;
  /** Injectable id for deterministic tests. */
  id?: string;
  requestedAt?: string;
}

export interface InterruptRepository {
  /**
   * Records the intent. Idempotent per (task, intent) while outstanding: a
   * double-click returns the existing request instead of stacking a second one.
   */
  request(input: RequestInterruptInput): Promise<InterruptRecord>;
  /** The oldest unacknowledged request for a task, if any. */
  pending(taskId: string): Promise<InterruptRecord | undefined>;
  listForTask(taskId: string): Promise<InterruptRecord[]>;
  /** Marks a request as observed. Idempotent. */
  acknowledge(input: {
    taskId: string;
    intent: InterruptIntent;
    by?: string;
    at?: string;
  }): Promise<InterruptRecord | undefined>;
  /** Drops outstanding requests — used when a task is resumed or retried. */
  clear(taskId: string): Promise<number>;
}

export function mapInterrupt(row: Row): InterruptRecord {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    intent: asString(row.intent) as InterruptIntent,
    reason: asString(row.reason),
    actor: asString(row.actor),
    requestedAt: asIso(row.requested_at),
    ...(asNullableIso(row.acknowledged_at) ? { acknowledgedAt: asNullableIso(row.acknowledged_at)! } : {}),
    ...(row.acknowledged_by ? { acknowledgedBy: asString(row.acknowledged_by) } : {}),
  };
}

export class PostgresInterruptRepository extends Repository implements InterruptRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  async request(input: RequestInterruptInput): Promise<InterruptRecord> {
    return this.run(async (tx) => {
      const rows = await tx.query(
        `insert into task_interrupts (id, task_id, intent, reason, actor, requested_at)
         values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, coalesce($6::timestamptz, now()))
         on conflict (task_id, intent) where acknowledged_at is null
           do update set reason = excluded.reason, actor = excluded.actor
         returning *`,
        [
          input.id ?? null,
          input.taskId,
          input.intent,
          input.reason,
          input.actor ?? "human",
          input.requestedAt ?? null,
        ],
      );
      return mapInterrupt(requireRow(rows, "interrupt.request"));
    });
  }

  async pending(taskId: string): Promise<InterruptRecord | undefined> {
    const rows = await this.tx().query(
      `select * from task_interrupts
        where task_id = $1 and acknowledged_at is null
        order by requested_at asc
        limit 1`,
      [taskId],
    );
    return rows[0] ? mapInterrupt(rows[0]) : undefined;
  }

  async listForTask(taskId: string): Promise<InterruptRecord[]> {
    const rows = await this.tx().query(
      "select * from task_interrupts where task_id = $1 order by requested_at asc",
      [taskId],
    );
    return rows.map(mapInterrupt);
  }

  async acknowledge(input: {
    taskId: string;
    intent: InterruptIntent;
    by?: string;
    at?: string;
  }): Promise<InterruptRecord | undefined> {
    const rows = await this.tx().query(
      `update task_interrupts
          set acknowledged_at = coalesce($4::timestamptz, now()),
              acknowledged_by = $3
        where task_id = $1 and intent = $2 and acknowledged_at is null
    returning *`,
      [input.taskId, input.intent, input.by ?? "worker", input.at ?? null],
    );
    return rows[0] ? mapInterrupt(rows[0]) : undefined;
  }

  async clear(taskId: string): Promise<number> {
    const rows = await this.tx().query(
      "delete from task_interrupts where task_id = $1 and acknowledged_at is null returning id",
      [taskId],
    );
    return rows.length;
  }
}
