import type { StopReason, TaskState } from "./types.js";

/**
 * Task lifecycle state machine.
 *
 * Primary flow:
 *   PENDING -> CODING -> TESTING -> REVIEW
 *   REVIEW -> APPROVED -> DONE
 *   REVIEW -> REJECTED -> FIXING -> TESTING -> REVIEW   (loop)
 *
 * Deviation from the literal task spec, on purpose:
 *   APPROVED -> DONE is REQUIRED for "final state DONE or NEEDS_HUMAN" to be
 *   reachable at all. A state machine where DONE had no incoming edge could
 *   never satisfy the acceptance criteria.
 *
 * Exhaustion policy: when the review budget is spent the runner calls
 * `reachableTerminal()` which records the terminal state directly (REVIEW ->
 * NEEDS_HUMAN) instead of inventing transitional edges. The graph below stays a
 * faithful description of the *happy path*; exhaustion is a policy decision,
 * not a transition.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  PENDING: ["CODING"],
  CODING: ["TESTING"],
  TESTING: ["REVIEW"],
  REVIEW: ["APPROVED", "REJECTED"],
  REJECTED: ["FIXING"],
  FIXING: ["TESTING"],
  APPROVED: ["DONE"],
  DONE: [],
  NEEDS_HUMAN: [],
};

export class IllegalStateTransitionError extends Error {
  readonly from: TaskState;
  readonly to: TaskState;

  constructor(from: TaskState, to: TaskState) {
    super(`Illegal task state transition: ${from} -> ${to}`);
    this.name = "IllegalStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function allowedTransitions(from: TaskState): readonly TaskState[] {
  return TASK_TRANSITIONS[from];
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new IllegalStateTransitionError(from, to);
  }
}

export function isTerminal(state: TaskState): boolean {
  return TASK_TRANSITIONS[state].length === 0;
}

/**
 * Where the runner is allowed to *stop* when the pipeline cannot continue.
 * DONE is reachable only from APPROVED; NEEDS_HUMAN is reachable from the
 * states where a human must take over.
 */
const TERMINAL_REACHABILITY: Readonly<Record<TaskState, readonly TaskState[]>> = {
  PENDING: ["NEEDS_HUMAN"],
  CODING: ["NEEDS_HUMAN"],
  TESTING: ["NEEDS_HUMAN"],
  REVIEW: ["NEEDS_HUMAN"],
  REJECTED: ["NEEDS_HUMAN"],
  FIXING: ["NEEDS_HUMAN"],
  APPROVED: ["DONE"],
  DONE: [],
  NEEDS_HUMAN: [],
};

export function reachableTerminal(from: TaskState): TaskState | undefined {
  return TERMINAL_REACHABILITY[from][0];
}

/** Outcome of spending the review budget. Kept as data so the loop is testable. */
export interface BudgetDecision {
  stop: boolean;
  reason?: StopReason;
}

export interface ReviewBudget {
  /** Total review passes allowed. */
  maxReviewCycles: number;
}

/**
 * Cycles are counted *before* the transition into REVIEW, so:
 *   maxReviewCycles = 3 admits exactly 3 review passes.
 * After pass 3 is rejected there is no budget left for pass 4, so we stop.
 */
export function reviewBudgetDecision(
  cyclesUsed: number,
  budget: ReviewBudget,
): BudgetDecision {
  if (!Number.isInteger(budget.maxReviewCycles) || budget.maxReviewCycles < 1) {
    throw new RangeError(
      `maxReviewCycles must be a positive integer, received ${String(budget.maxReviewCycles)}`,
    );
  }
  if (cyclesUsed >= budget.maxReviewCycles) {
    return { stop: true, reason: "MAX_REVIEW_CYCLES" };
  }
  return { stop: false };
}
