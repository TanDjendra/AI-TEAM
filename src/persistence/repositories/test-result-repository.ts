/**
 * Test-result persistence.
 *
 * The authoritative run is identified structurally rather than by a boolean that
 * could drift: the row with `test_key = 'final'` is the last test run the harness
 * accepted, and a partial unique index guarantees there is at most one per task.
 * That is the "test terakhir yang dianggap authoritative" requirement expressed
 * as a database invariant.
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
  requireRow,
  type Row,
} from "../rows.js";
import { summarizeOutput } from "../redaction.js";

/** The reserved key for the authoritative test run. */
export const AUTHORITATIVE_TEST_KEY = "final";

export interface TestResultRecord {
  id: string;
  taskId: string;
  agentId?: string;
  cycle: number;
  testKey: string;
  command: string;
  exitCode?: number | null;
  passed: boolean;
  timedOut: boolean;
  outputSummary?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  createdAt: string;
}

export interface SaveTestResultInput {
  taskId: string;
  agentId?: string;
  cycle?: number;
  /**
   * Stable key for this test run. Use `AUTHORITATIVE_TEST_KEY` for the run the
   * harness treats as the final word; anything else (e.g. a per-command key) is
   * kept as history.
   */
  testKey?: string;
  command: string;
  exitCode?: number | null;
  passed: boolean;
  timedOut?: boolean;
  outputSummary?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface TestResultRepository {
  save(input: SaveTestResultInput): Promise<TestResultRecord>;
  /** The authoritative result, or undefined when no test has been accepted. */
  authoritative(taskId: string): Promise<TestResultRecord | undefined>;
  listForTask(taskId: string): Promise<TestResultRecord[]>;
  historyForTask(taskId: string): Promise<TestResultRecord[]>;
  countForTask(taskId: string): Promise<number>;
}

export function mapTestResult(row: Row): TestResultRecord {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    ...(asNullableString(row.agent_id) ? { agentId: asNullableString(row.agent_id)! } : {}),
    cycle: asNumber(row.cycle),
    testKey: asString(row.test_key),
    command: asString(row.command),
    ...(row.exit_code === null || row.exit_code === undefined
      ? {}
      : { exitCode: asNullableNumber(row.exit_code) ?? null }),
    passed: asBoolean(row.passed),
    timedOut: asBoolean(row.timed_out),
    ...(asNullableString(row.output_summary)
      ? { outputSummary: asNullableString(row.output_summary)! }
      : {}),
    startedAt: asIso(row.started_at),
    ...(asNullableIso(row.finished_at) ? { finishedAt: asNullableIso(row.finished_at)! } : {}),
    ...(row.duration_ms === null || row.duration_ms === undefined
      ? {}
      : { durationMs: asNumber(row.duration_ms) }),
    createdAt: asIso(row.created_at),
  };
}

export class PostgresTestResultRepository extends Repository implements TestResultRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  /**
   * Records a test run.
   *
   * The authoritative key is upserted (the latest run wins), while other keys
   * append. This mirrors the harness rule exactly: "the last test-class command
   * is what counts", with every earlier run still available as history.
   */
  async save(input: SaveTestResultInput): Promise<TestResultRecord> {
    const testKey = input.testKey ?? AUTHORITATIVE_TEST_KEY;
    const summary =
      input.outputSummary === undefined ? undefined : summarizeOutput(input.outputSummary);

    return withDbRetry(async () =>
      this.run(async (tx) => {
        if (testKey === AUTHORITATIVE_TEST_KEY) {
          // Delete-then-insert keeps a partial unique index satisfied and is
          // still atomic inside this transaction.
          await tx.query("delete from test_results where task_id = $1 and test_key = $2", [
            input.taskId,
            testKey,
          ]);
        }

        const rows = await tx.query(
          `insert into test_results (task_id, agent_id, cycle, test_key, command, exit_code,
                                     passed, timed_out, output_summary, started_at, finished_at, duration_ms)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                   coalesce($10::timestamptz, now()),
                   coalesce($11::timestamptz, now()),
                   $12)
           returning *`,
          [
            input.taskId,
            input.agentId ?? null,
            input.cycle ?? 0,
            testKey,
            input.command,
            input.exitCode ?? null,
            input.passed,
            input.timedOut ?? false,
            summary ?? null,
            input.startedAt ?? null,
            input.finishedAt ?? null,
            input.durationMs ?? null,
          ],
        );
        return mapTestResult(requireRow(rows, "testResult.save"));
      }),
    );
  }

  async authoritative(taskId: string): Promise<TestResultRecord | undefined> {
    const rows = await this.tx().query(
      "select * from test_results where task_id = $1 and test_key = $2",
      [taskId, AUTHORITATIVE_TEST_KEY],
    );
    return rows[0] ? mapTestResult(rows[0]) : undefined;
  }

  /** All runs, including the authoritative one. */
  async listForTask(taskId: string): Promise<TestResultRecord[]> {
    const rows = await this.tx().query(
      "select * from test_results where task_id = $1 order by started_at asc, created_at asc",
      [taskId],
    );
    return rows.map(mapTestResult);
  }

  /** Only the non-authoritative history rows. */
  async historyForTask(taskId: string): Promise<TestResultRecord[]> {
    const rows = await this.tx().query(
      `select * from test_results
        where task_id = $1 and test_key <> $2
        order by started_at asc, created_at asc`,
      [taskId, AUTHORITATIVE_TEST_KEY],
    );
    return rows.map(mapTestResult);
  }

  async countForTask(taskId: string): Promise<number> {
    const rows = await this.tx().query<{ count: string }>(
      "select count(*)::text as count from test_results where task_id = $1",
      [taskId],
    );
    return asNumber(rows[0]?.count, 0);
  }
}
