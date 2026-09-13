/**
 * File-change persistence.
 *
 * Only metadata is stored — path, change type, a short summary and an optional
 * git hash. **Never the file body**, which is what the specification asks for and
 * also what keeps secrets in a generated file out of the database.
 *
 * One row per (task, path): a second write updates the record instead of
 * producing duplicate noise for the dashboard.
 */

import type { Db, UnitOfWork } from "../db.js";
import { Repository, withDbRetry } from "../db.js";
import {
  asIso,
  asNullableString,
  asString,
  requireRow,
  type Row,
} from "../rows.js";
import { summarize } from "../redaction.js";

export type FileChangeType = "created" | "modified" | "deleted";

export interface FileChangeRecord {
  id: string;
  taskId: string;
  agentId?: string;
  path: string;
  changeType: FileChangeType;
  summary?: string;
  gitBaseHash?: string;
  occurredAt: string;
  createdAt: string;
}

export interface RecordFileChangeInput {
  taskId: string;
  agentId?: string;
  path: string;
  changeType: FileChangeType;
  summary?: string;
  gitBaseHash?: string;
  occurredAt?: string;
}

export interface FileChangeRepository {
  record(input: RecordFileChangeInput): Promise<FileChangeRecord>;
  listForTask(taskId: string): Promise<FileChangeRecord[]>;
  countForTask(taskId: string): Promise<number>;
  pathsForTask(taskId: string): Promise<string[]>;
}

export function mapFileChange(row: Row): FileChangeRecord {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    ...(asNullableString(row.agent_id) ? { agentId: asNullableString(row.agent_id)! } : {}),
    path: asString(row.path),
    changeType: asString(row.change_type) as FileChangeType,
    ...(asNullableString(row.summary) ? { summary: asNullableString(row.summary)! } : {}),
    ...(asNullableString(row.git_base_hash)
      ? { gitBaseHash: asNullableString(row.git_base_hash)! }
      : {}),
    occurredAt: asIso(row.occurred_at),
    createdAt: asIso(row.created_at),
  };
}

export class PostgresFileChangeRepository extends Repository implements FileChangeRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  async record(input: RecordFileChangeInput): Promise<FileChangeRecord> {
    const summary = input.summary === undefined ? undefined : summarize(input.summary);
    return withDbRetry(async () =>
      this.run(async (tx) => {
        const rows = await tx.query(
          `insert into file_changes (task_id, agent_id, path, change_type, summary, git_base_hash, occurred_at)
           values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))
           on conflict (task_id, path) do update
             set change_type = excluded.change_type,
                 summary = excluded.summary,
                 git_base_hash = coalesce(excluded.git_base_hash, file_changes.git_base_hash),
                 occurred_at = excluded.occurred_at
           returning *`,
          [
            input.taskId,
            input.agentId ?? null,
            input.path,
            input.changeType,
            summary ?? null,
            input.gitBaseHash ?? null,
            input.occurredAt ?? null,
          ],
        );
        return mapFileChange(requireRow(rows, "fileChange.record"));
      }),
    );
  }

  async listForTask(taskId: string): Promise<FileChangeRecord[]> {
    const rows = await this.tx().query(
      "select * from file_changes where task_id = $1 order by occurred_at asc, created_at asc",
      [taskId],
    );
    return rows.map(mapFileChange);
  }

  async countForTask(taskId: string): Promise<number> {
    const rows = await this.tx().query<{ count: string }>(
      "select count(*)::text as count from file_changes where task_id = $1",
      [taskId],
    );
    const count = rows[0]?.count;
    return typeof count === "string" ? Number(count) : 0;
  }

  async pathsForTask(taskId: string): Promise<string[]> {
    const rows = await this.tx().query<{ path: string }>(
      "select path from file_changes where task_id = $1 order by path asc",
      [taskId],
    );
    return rows.map((row) => asString(row.path));
  }
}
