/**
 * Review persistence — APPEND ONLY.
 *
 * A previous review is never overwritten: the unique constraint is on
 * (task_id, cycle), so re-running the same cycle is rejected by the database
 * rather than silently replacing history.
 */

import type { Db, UnitOfWork } from "../db.js";
import { Repository, withDbRetry } from "../db.js";
import {
  asIso,
  asNullableString,
  asNumber,
  asString,
  asStringArray,
  requireRow,
  type Row,
} from "../rows.js";
import type { ReviewSeverity, ReviewVerdict } from "../../domain/types.js";

export interface ReviewRecord {
  id: string;
  taskId: string;
  runId?: string;
  reviewer: string;
  cycle: number;
  verdict: ReviewVerdict;
  severity: ReviewSeverity;
  summary: string;
  issues: string[];
  requiredFixes: string[];
  createdAt: string;
}

export interface SaveReviewInput {
  taskId: string;
  runId?: string;
  reviewer: string;
  cycle: number;
  verdict: ReviewVerdict;
  severity: ReviewSeverity;
  summary: string;
  issues: string[];
  requiredFixes: string[];
  createdAt?: string;
  agentId?: string;
}

export interface ReviewRepository {
  /**
   * Records the decision for a (task, cycle).
   *
   * Idempotent: an existing decision for the cycle is returned unchanged, so a
   * retried task cannot fail on the unique index and history is never rewritten.
   */
  save(input: SaveReviewInput): Promise<ReviewRecord>;
  findByCycle(taskId: string, cycle: number): Promise<ReviewRecord | undefined>;
  listForTask(taskId: string): Promise<ReviewRecord[]>;
  latestForTask(taskId: string): Promise<ReviewRecord | undefined>;
  /** Cycle numbers in which a reviewer already had its say. */
  decidedCycles(taskId: string): Promise<number[]>;
  /** Most recent reviews across all tasks, for the Review Center. */
  listRecent(limit?: number): Promise<ReviewRecord[]>;
  /** Verdict counters for one reviewer, derived from stored rows only. */
  statsForReviewer(reviewer: string): Promise<{ total: number; approved: number; rejected: number }>;
  /** Total rows, for the header counters. */
  countAll(): Promise<number>;
}

export function mapReview(row: Row): ReviewRecord {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    ...(asNullableString(row.run_id) ? { runId: asNullableString(row.run_id)! } : {}),
    reviewer: asString(row.reviewer),
    cycle: asNumber(row.cycle),
    verdict: asString(row.verdict) as ReviewVerdict,
    severity: asString(row.severity) as ReviewSeverity,
    summary: asString(row.summary),
    issues: asStringArray(row.issues),
    requiredFixes: asStringArray(row.required_fixes),
    createdAt: asIso(row.created_at),
  };
}

export class PostgresReviewRepository extends Repository implements ReviewRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  /**
   * Inserts a review for a (task, cycle). The unique index on that pair is the
   * concurrency guard for "two reviewers must not decide the same cycle".
   *
   * The write is idempotent: if a decision already exists for the cycle it is
   * RETURNED rather than raising. Without this, re-running a cycle (a retried
   * task, or an orchestrator restart) failed with a unique-violation that was
   * treated as an unhealthy-persistence event and turned an approved task into
   * NEEDS_HUMAN. The first decision stands — this never overwrites, so review
   * history stays append-only.
   */
  async save(input: SaveReviewInput): Promise<ReviewRecord> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        const rows = await tx.query(
          `insert into reviews (task_id, run_id, reviewer, cycle, verdict, severity,
                                summary, issues, required_fixes, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, coalesce($10::timestamptz, now()))
           on conflict (task_id, cycle) do nothing
           returning *`,
          [
            input.taskId,
            input.runId ?? null,
            input.reviewer,
            input.cycle,
            input.verdict,
            input.severity,
            input.summary,
            JSON.stringify(input.issues),
            JSON.stringify(input.requiredFixes),
            input.createdAt ?? null,
          ],
        );

        if (rows[0]) return mapReview(rows[0]);

        // Already decided: return the recorded decision unchanged.
        const existing = await tx.query(
          "select * from reviews where task_id = $1 and cycle = $2",
          [input.taskId, input.cycle],
        );
        return mapReview(requireRow(existing, "review.save.existing"));
      }),
    );
  }

  async findByCycle(taskId: string, cycle: number): Promise<ReviewRecord | undefined> {
    const rows = await this.tx().query(
      "select * from reviews where task_id = $1 and cycle = $2",
      [taskId, cycle],
    );
    return rows[0] ? mapReview(rows[0]) : undefined;
  }

  async listForTask(taskId: string): Promise<ReviewRecord[]> {
    const rows = await this.tx().query(
      "select * from reviews where task_id = $1 order by cycle asc",
      [taskId],
    );
    return rows.map(mapReview);
  }

  async latestForTask(taskId: string): Promise<ReviewRecord | undefined> {
    const rows = await this.tx().query(
      "select * from reviews where task_id = $1 order by cycle desc limit 1",
      [taskId],
    );
    return rows[0] ? mapReview(rows[0]) : undefined;
  }

  async decidedCycles(taskId: string): Promise<number[]> {
    const rows = await this.tx().query<{ cycle: number }>(
      "select cycle from reviews where task_id = $1 order by cycle asc",
      [taskId],
    );
    return rows.map((row) => asNumber(row.cycle));
  }

  async listRecent(limit = 100): Promise<ReviewRecord[]> {
    const rows = await this.tx().query(
      "select * from reviews order by created_at desc, cycle desc limit $1",
      [limit],
    );
    return rows.map(mapReview);
  }

  async statsForReviewer(
    reviewer: string,
  ): Promise<{ total: number; approved: number; rejected: number }> {
    const rows = await this.tx().query<{ total: string; approved: string; rejected: string }>(
      `select
         count(*)::text as total,
         count(*) filter (where verdict = 'APPROVED')::text as approved,
         count(*) filter (where verdict = 'REJECTED')::text as rejected
       from reviews
       where reviewer = $1`,
      [reviewer],
    );
    const row = rows[0];
    return {
      total: asNumber(row?.total, 0),
      approved: asNumber(row?.approved, 0),
      rejected: asNumber(row?.rejected, 0),
    };
  }

  async countAll(): Promise<number> {
    const rows = await this.tx().query<{ count: string }>(
      "select count(*)::text as count from reviews",
    );
    return asNumber(rows[0]?.count, 0);
  }
}
