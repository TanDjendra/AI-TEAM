/**
 * Activity log persistence — the event journal.
 *
 * `event_id` is the primary key, so writing the same event twice is a no-op
 * (`on conflict do nothing`). `insert()` returns whether the row was actually
 * created, which callers use to detect duplicates.
 *
 * Every payload is redacted before it reaches the database: this is the single
 * most likely place for an API key to leak into a table.
 */

import type { Db, UnitOfWork } from "../db.js";
import { Repository } from "../db.js";
import {
  asIso,
  asNullableString,
  asNumber,
  asString,
  asStringRecord,
  type Row,
} from "../rows.js";
import { redact } from "../redaction.js";
import type { AnyTaskEvent } from "../../events/types.js";

export interface ActivityLogRecord {
  eventId: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  eventType: string;
  cycle?: number;
  payload: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
  /**
   * Database-assigned monotonic sequence.
   *
   * This is the cursor the realtime stream polls with: it is total and stable,
   * unlike `occurred_at` (millisecond resolution, and two events can share one).
   */
  publishSeq: number;
}

export interface AppendActivityInput {
  eventId: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  eventType: string;
  cycle?: number;
  payload?: Record<string, unknown>;
  occurredAt?: string;
}

export interface ActivityLogRepository {
  /** Returns false when the event id was already present (idempotent). */
  append(input: AppendActivityInput): Promise<boolean>;
  /** Convenience: append a typed bus event. */
  appendEvent(event: AnyTaskEvent, options?: { runId?: string }): Promise<boolean>;
  /**
   * Rows belonging to a task.
   *
   * `includeUnassigned` also returns rows whose task_id is null. Agents emit
   * events with their logical key ("coder") rather than the task's UUID, so the
   * recorder may not have been able to attribute a row to a task at write time.
   * Reading them back with the same allowance keeps the timeline complete.
   */
  listForTask(taskId: string, options?: { limit?: number; includeUnassigned?: boolean }): Promise<ActivityLogRecord[]>;
  listByType(eventType: string, limit?: number): Promise<ActivityLogRecord[]>;
  /** Most recent activity for one agent. */
  listForAgent(agentId: string, limit?: number): Promise<ActivityLogRecord[]>;
  countForTask(taskId: string): Promise<number>;
  /** Total rows, for the header counters. */
  countAll(): Promise<number>;
  has(eventId: string): Promise<boolean>;
  latest(limit?: number): Promise<ActivityLogRecord[]>;
  /**
   * Rows with `publish_seq` greater than the cursor, oldest first.
   *
   * This is how the dashboard follows the journal across processes: the
   * orchestrator may run in another process entirely, so its events reach this
   * reader through the database rather than an in-process bus.
   */
  listAfterSeq(seq: number, limit?: number): Promise<ActivityLogRecord[]>;
  /** Highest `publish_seq` currently stored (0 when empty). */
  maxSeq(): Promise<number>;
}

export function mapActivity(row: Row): ActivityLogRecord {
  return {
    eventId: asString(row.event_id),
    ...(asNullableString(row.task_id) ? { taskId: asNullableString(row.task_id)! } : {}),
    ...(asNullableString(row.run_id) ? { runId: asNullableString(row.run_id)! } : {}),
    ...(asNullableString(row.agent_id) ? { agentId: asNullableString(row.agent_id)! } : {}),
    eventType: asString(row.event_type),
    ...(row.cycle === null || row.cycle === undefined ? {} : { cycle: asNumber(row.cycle) }),
    payload: asStringRecord(row.payload),
    occurredAt: asIso(row.occurred_at),
    createdAt: asIso(row.created_at),
    publishSeq: asNumber(row.publish_seq, 0),
  };
}

export class PostgresActivityLogRepository extends Repository implements ActivityLogRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  async append(input: AppendActivityInput): Promise<boolean> {
    const payload = redact(input.payload ?? {}) as Record<string, unknown>;
    const rows = await this.run(async (tx) =>
      tx.query(
        `insert into activity_logs (event_id, task_id, run_id, agent_id, event_type, cycle, payload, occurred_at)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, coalesce($8::timestamptz, now()))
         on conflict (event_id) do nothing
         returning event_id`,
        [
          input.eventId,
          input.taskId ?? null,
          input.runId ?? null,
          input.agentId ?? null,
          input.eventType,
          input.cycle ?? null,
          JSON.stringify(payload),
          input.occurredAt ?? null,
        ],
      ),
    );
    return rows.length > 0;
  }

  async appendEvent(event: AnyTaskEvent, options: { runId?: string } = {}): Promise<boolean> {
    return this.append({
      eventId: event.id,
      taskId: event.taskId,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {}),
      eventType: event.type,
      ...(event.cycle === undefined ? {} : { cycle: event.cycle }),
      payload: event.payload as unknown as Record<string, unknown>,
      occurredAt: event.timestamp,
    });
  }

  async listForTask(
    taskId: string,
    options: { limit?: number; includeUnassigned?: boolean } = {},
  ): Promise<ActivityLogRecord[]> {
    // Ordered by publish_seq: total and stable, unlike a millisecond timestamp.
    const where = options.includeUnassigned
      ? "where task_id = $1 or task_id is null"
      : "where task_id = $1";
    const rows = await this.tx().query(
      `select * from activity_logs
        ${where}
        order by publish_seq asc
        limit $2`,
      [taskId, options.limit ?? 1_000],
    );
    return rows.map(mapActivity);
  }

  async listByType(eventType: string, limit = 200): Promise<ActivityLogRecord[]> {
    const rows = await this.tx().query(
      `select * from activity_logs
        where event_type = $1
        order by publish_seq desc
        limit $2`,
      [eventType, limit],
    );
    return rows.map(mapActivity);
  }

  async countForTask(taskId: string): Promise<number> {
    const rows = await this.tx().query<{ count: string }>(
      "select count(*)::text as count from activity_logs where task_id = $1",
      [taskId],
    );
    return asNumber(rows[0]?.count, 0);
  }

  async countAll(): Promise<number> {
    const rows = await this.tx().query<{ count: string }>(
      "select count(*)::text as count from activity_logs",
    );
    return asNumber(rows[0]?.count, 0);
  }

  async listForAgent(agentId: string, limit = 20): Promise<ActivityLogRecord[]> {
    const rows = await this.tx().query(
      `select * from activity_logs
        where agent_id = $1
        order by publish_seq desc
        limit $2`,
      [agentId, limit],
    );
    return rows.map(mapActivity);
  }

  async has(eventId: string): Promise<boolean> {
    const rows = await this.tx().query("select 1 from activity_logs where event_id = $1", [eventId]);
    return rows.length > 0;
  }

  async latest(limit = 100): Promise<ActivityLogRecord[]> {
    const rows = await this.tx().query(
      `select * from activity_logs
        order by publish_seq desc
        limit $1`,
      [limit],
    );
    return rows.map(mapActivity);
  }

  async listAfterSeq(seq: number, limit = 200): Promise<ActivityLogRecord[]> {
    const rows = await this.tx().query(
      `select * from activity_logs
        where publish_seq > $1
        order by publish_seq asc
        limit $2`,
      [seq, limit],
    );
    return rows.map(mapActivity);
  }

  async maxSeq(): Promise<number> {
    const rows = await this.tx().query<{ max: string | null }>(
      "select max(publish_seq)::text as max from activity_logs",
    );
    return asNumber(rows[0]?.max ?? null, 0);
  }
}
