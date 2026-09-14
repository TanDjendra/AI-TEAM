import { randomUUID } from "node:crypto";
import type { BudgetAuthorizer, BudgetReservation, TokenUsageDelta, UsageLedger } from "../domain/budget.js";
import { BudgetExceededError } from "../domain/errors.js";
import type { RunSession } from "../domain/run-session.js";

export class DefaultBudgetAuthorizer implements BudgetAuthorizer {
  constructor(
    private readonly ledger: UsageLedger,
    private readonly taskBudgetLimit: number
  ) {}

  async reserve(session: RunSession, agentId: string, estimatedTokens: number): Promise<BudgetReservation> {
    const currentUsage = await this.ledger.getTotalUsage(session.taskId);
    
    if (currentUsage + estimatedTokens > this.taskBudgetLimit) {
      throw new BudgetExceededError(
        `Budget exceeded for task ${session.taskId}: limit is ${this.taskBudgetLimit} tokens, ` +
        `current usage is ${currentUsage} tokens, and ${estimatedTokens} more were requested.`
      );
    }

    const reservation: BudgetReservation = {
      reservationId: randomUUID(),
      taskId: session.taskId,
      agentId,
      allocatedTokens: estimatedTokens,
    };

    await this.ledger.createReservation(reservation);
    return reservation;
  }

  async reconcile(
    reservation: BudgetReservation,
    session: RunSession,
    actualUsage: TokenUsageDelta,
    requestId: string,
    cycle: number,
    model: string,
    estimatedCostUsd: number,
    priceVersion: string,
    profileSnapshotHash: string
  ): Promise<void> {
    if (actualUsage.totalTokens === 0 && actualUsage.promptTokens === 0 && actualUsage.completionTokens === 0) {
      await this.ledger.updateReservationStatus(reservation.reservationId, "CANCELLED");
      return;
    }

    await this.ledger.recordActual({
      id: randomUUID(),
      taskId: session.taskId,
      agentId: reservation.agentId,
      cycle,
      model,
      requestId,
      usage: actualUsage,
      estimatedCostUsd,
      priceVersion,
      profileSnapshotHash,
    });
    await this.ledger.updateReservationStatus(reservation.reservationId, "RECONCILED");
  }
}

export class NoopBudgetAuthorizer implements BudgetAuthorizer {
  async reserve(session: RunSession, agentId: string, estimatedTokens: number): Promise<BudgetReservation> {
    return {
      reservationId: randomUUID(),
      taskId: session.taskId,
      agentId,
      allocatedTokens: estimatedTokens,
    };
  }

  async reconcile(
    reservation: BudgetReservation,
    session: RunSession,
    actualUsage: TokenUsageDelta,
    requestId: string,
    cycle: number,
    model: string,
    estimatedCostUsd: number,
    priceVersion: string,
    profileSnapshotHash: string
  ): Promise<void> {}
}
