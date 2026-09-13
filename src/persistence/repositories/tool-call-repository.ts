/**
 * Tool-call persistence.
 *
 * Arguments and output are redacted and size-bounded before insert: a tool call
 * may carry a command whose output is megabytes long, or (in a badly written
 * tool) a credential.
 */

import type { Db, UnitOfWork } from "../db.js";
import { Repository, withDbRetry } from "../db.js";
import {
  asBoolean,
  asIso,
  asNullableIso,
  asNullableNumber,
  asNullableString,
  asNumber,
  asString,
  asStringRecord,
  requireRow,
  type Row,
} from "../rows.js";
import { redact, summarizeOutput } from "../redaction.js";

export interface ToolCallRecord {
  id: string;
  toolCallId: string;
  taskId: string;
  agentId?: string;
  tool: string;
  arguments: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  success?: boolean;
  exitCode?: number | null;
  outputSummary?: string;
  createdAt: string;
}

export interface StartToolCallInput {
  toolCallId: string;
  taskId: string;
  agentId?: string;
  tool: string;
  arguments?: Record<string, unknown>;
  startedAt?: string;
}

export interface FinishToolCallInput {
  toolCallId: string;
  taskId: string;
  success: boolean;
  exitCode?: number | null;
  outputSummary?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface ToolCallRepository {
  start(input: StartToolCallInput): Promise<ToolCallRecord>;
  finish(input: FinishToolCallInput): Promise<ToolCallRecord | undefined>;
  listForTask(taskId: string): Promise<ToolCallRecord[]>;
  countForTask(taskId: string): Promise<number>;
  failedForTask(taskId: string): Promise<ToolCallRecord[]>;
}

export function mapToolCall(row: Row): ToolCallRecord {
  return {
    id: asString(row.id),
    toolCallId: asString(row.tool_call_id),
    taskId: asString(row.task_id),
    ...(asNullableString(row.agent_id) ? { agentId: asNullableString(row.agent_id)! } : {}),
    tool: asString(row.tool),
    arguments: asStringRecord(row.arguments),
    startedAt: asIso(row.started_at),
    ...(asNullableIso(row.finished_at) ? { finishedAt: asNullableIso(row.finished_at)! } : {}),
    ...(row.duration_ms === null || row.duration_ms === undefined
      ? {}
      : { durationMs: asNumber(row.duration_ms) }),
    ...(row.success === null || row.success === undefined
      ? {}
      : { success: asBoolean(row.success) }),
    ...(row.exit_code === null || row.exit_code === undefined
      ? {}
      : { exitCode: asNullableNumber(row.exit_code) ?? null }),
    ...(asNullableString(row.output_summary)
      ? { outputSummary: asNullableString(row.output_summary)! }
      : {}),
    createdAt: asIso(row.created_at),
  };
}

export class PostgresToolCallRepository extends Repository implements ToolCallRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  /**
   * Idempotent on (task_id, tool_call_id): re-recording the same call updates
   * the start record instead of inserting a duplicate row.
   */
  async start(input: StartToolCallInput): Promise<ToolCallRecord> {
    const args = redact(input.arguments ?? {}) as Record<string, unknown>;
    return withDbRetry(async () =>
      this.run(async (tx) => {
        const rows = await tx.query(
          `insert into tool_calls (tool_call_id, task_id, agent_id, tool, arguments, started_at)
           values ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now()))
           on conflict (task_id, tool_call_id) do update
             set tool = excluded.tool,
                 arguments = excluded.arguments
           returning *`,
          [
            input.toolCallId,
            input.taskId,
            input.agentId ?? null,
            input.tool,
            JSON.stringify(args),
            input.startedAt ?? null,
          ],
        );
        return mapToolCall(requireRow(rows, "toolCall.start"));
      }),
    );
  }

  async finish(input: FinishToolCallInput): Promise<ToolCallRecord | undefined> {
    const summary =
      input.outputSummary === undefined ? undefined : summarizeOutput(input.outputSummary);
    return withDbRetry(async () =>
      this.run(async (tx) => {
        const rows = await tx.query(
          `update tool_calls
              set finished_at = coalesce($4::timestamptz, now()),
                  success = $3,
                  exit_code = $5,
                  output_summary = $6,
                  duration_ms = coalesce(
                    $7::int,
                    greatest(0, (extract(epoch from (now() - started_at)) * 1000))::int
                  )
            where task_id = $1 and tool_call_id = $2
        returning *`,
          [
            input.taskId,
            input.toolCallId,
            input.success,
            input.finishedAt ?? null,
            input.exitCode ?? null,
            summary ?? null,
            input.durationMs ?? null,
          ],
        );
        return rows[0] ? mapToolCall(rows[0]) : undefined;
      }),
    );
  }

  async listForTask(taskId: string): Promise<ToolCallRecord[]> {
    const rows = await this.tx().query(
      "select * from tool_calls where task_id = $1 order by started_at asc, created_at asc",
      [taskId],
    );
    return rows.map(mapToolCall);
  }

  async countForTask(taskId: string): Promise<number> {
    const rows = await this.tx().query<{ count: string }>(
      "select count(*)::text as count from tool_calls where task_id = $1",
      [taskId],
    );
    return asNumber(rows[0]?.count, 0);
  }

  async failedForTask(taskId: string): Promise<ToolCallRecord[]> {
    const rows = await this.tx().query(
      "select * from tool_calls where task_id = $1 and success = false order by started_at asc",
      [taskId],
    );
    return rows.map(mapToolCall);
  }
}
