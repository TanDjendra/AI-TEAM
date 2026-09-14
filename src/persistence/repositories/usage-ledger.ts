import { randomUUID } from "node:crypto";
import type { Db, UnitOfWork } from "../db.js";
import { Repository, withDbRetry } from "../db.js";
import type { LedgerEntry, UsageLedger } from "../../domain/budget.js";
import { asNumber } from "../rows.js";

export class PostgresUsageLedger extends Repository implements UsageLedger {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  async recordActual(entry: LedgerEntry): Promise<void> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        // Appends to the model_usage_ledger with strict idempotency on request_id.
        // It deliberately does NOT store the raw prompt or completion texts.
        await tx.query(
          `INSERT INTO model_usage_ledger (
            id, task_id, agent_id, cycle, model, request_id, 
            prompt_tokens, completion_tokens, total_tokens,
            estimated_cost_usd, price_version, profile_snapshot_hash
          ) VALUES (
            $1, (SELECT id FROM tasks WHERE external_id = $2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
          )
          ON CONFLICT (request_id) DO NOTHING`,
          [
            entry.id || randomUUID(),
            entry.taskId,
            entry.agentId,
            entry.cycle,
            entry.model,
            entry.requestId,
            entry.usage.promptTokens,
            entry.usage.completionTokens,
            entry.usage.totalTokens,
            entry.estimatedCostUsd,
            entry.priceVersion,
            entry.profileSnapshotHash
          ]
        );
      })
    );
  }

  async getTotalUsage(taskId: string): Promise<number> {
    const rows = await this.tx().query(
      `SELECT SUM(total_tokens) as total 
       FROM model_usage_ledger 
       WHERE task_id = (SELECT id FROM tasks WHERE external_id = $1)`,
      [taskId]
    );
    const total = rows[0]?.total;
    return total ? asNumber(total) : 0;
  }

  async createReservation(reservation: import("../../domain/budget.js").BudgetReservation): Promise<void> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        await tx.query(
          `INSERT INTO budget_reservations (id, task_id, agent_id, allocated_tokens, status)
           VALUES ($1, (SELECT id FROM tasks WHERE external_id = $2), $3, $4, 'PENDING')`,
          [
            reservation.reservationId,
            reservation.taskId,
            reservation.agentId,
            reservation.allocatedTokens
          ]
        );
      })
    );
  }

  async updateReservationStatus(reservationId: string, status: "RECONCILED" | "CANCELLED"): Promise<void> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        await tx.query(
          `UPDATE budget_reservations SET status = $2 WHERE id = $1`,
          [reservationId, status]
        );
      })
    );
  }
}
