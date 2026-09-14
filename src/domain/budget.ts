export interface TokenUsageDelta {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LedgerEntry {
  id: string; // UUID
  taskId: string;
  agentId: string;
  cycle: number;
  model: string;
  requestId: string; // Unique idempotency key per model call
  usage: TokenUsageDelta;
  estimatedCostUsd: number;
  priceVersion: string;
  profileSnapshotHash: string;
}

export interface UsageLedger {
  /**
   * Idempotently records actual token usage.
   * If requestId already exists, it is ignored safely.
   */
  recordActual(entry: LedgerEntry): Promise<void>;

  /**
   * Get total usage for a given task/agent to evaluate budget.
   */
  getTotalUsage(taskId: string): Promise<number>;

  /**
   * Creates a budget reservation.
   */
  createReservation(reservation: BudgetReservation): Promise<void>;

  /**
   * Updates a budget reservation status.
   */
  updateReservationStatus(reservationId: string, status: "RECONCILED" | "CANCELLED"): Promise<void>;
}

export interface BudgetReservation {
  reservationId: string;
  taskId: string;
  agentId: string;
  allocatedTokens: number;
}

import type { RunSession } from "./run-session.js";

export interface BudgetAuthorizer {
  /**
   * Checks if the task has enough remaining budget.
   * Throws BudgetExceededError if limit is reached.
   */
  reserve(session: RunSession, agentId: string, estimatedTokens: number): Promise<BudgetReservation>;

  /**
   * Reconciles the reservation with actual usage reported by the model.
   * Persists immediately to UsageLedger.
   */
  reconcile(
    reservation: BudgetReservation,
    session: RunSession,
    actualUsage: TokenUsageDelta,
    requestId: string,
    cycle: number,
    model: string,
    estimatedCostUsd: number,
    priceVersion: string,
    profileSnapshotHash: string
  ): Promise<void>;
}

