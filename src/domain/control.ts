/**
 * Human control model.
 *
 * One table decides which control action a status admits. The API validates
 * against it, the worker consults it, and the dashboard renders its buttons from
 * it — so a button can never offer an action the backend would reject, and an
 * illegal transition is impossible by construction rather than by convention.
 *
 * Control actions are intentionally separate from the domain state machine
 * (`task-machine.ts`): the machine describes how *agents* advance a task, while
 * this describes how a *human* overrides it. Several control actions change
 * status in a way the agent machine has no edge for (PAUSE and CANCEL), which is
 * why the superset lives here and the machine stays untouched.
 */

import type { TaskStatus } from "../events/types.js";

/** Actions a project owner can invoke from the dashboard. */
export const CONTROL_ACTIONS = [
  "start",
  "pause",
  "resume",
  "cancel",
  "retry",
  "approve",
  /**
   * Recovery is not a state transition — it is the operator asserting that a run
   * is dead. It is listed here so the dashboard can treat every owner action
   * uniformly, but the control matrix below does not gate it on status.
   */
  "recover",
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export function isControlAction(value: string): value is ControlAction {
  return (CONTROL_ACTIONS as readonly string[]).includes(value);
}

/** Statuses a task can be paused from — i.e. states where work is in flight. */
const PAUSABLE: readonly TaskStatus[] = ["CODING", "TESTING", "REVIEW", "FIXING", "REJECTED"];

/** Terminal statuses: nothing may wake them implicitly. */
const TERMINAL: readonly TaskStatus[] = ["DONE", "CANCELLED"];

/** A task stopped by policy or by a human can be re-queued. */
const RETRYABLE: readonly TaskStatus[] = ["NEEDS_HUMAN", "DONE", "CANCELLED"];

/**
 * The control matrix.
 *
 * PENDING        [start] [cancel]
 * CODING…REJECTED[pause] [cancel]
 * PAUSED         [resume] [cancel]
 * APPROVED       [approve]
 * NEEDS_HUMAN    [retry] [approve] [cancel]
 * DONE/CANCELLED [retry]
 *
 * There is exactly ONE way to start work (`start`), and it is only legal from
 * PENDING. A task in flight is never startable again — that is the double-start
 * guard, enforced here as well as by the database claim.
 */
export function allowedControlActions(status: TaskStatus): readonly ControlAction[] {
  const actions: ControlAction[] = [];

  if (status === "PENDING") {
    actions.push("start", "cancel");
  }

  if (PAUSABLE.includes(status)) {
    actions.push("pause", "cancel");
  }

  if (status === "PAUSED") {
    actions.push("resume", "cancel");
  }

  if (status === "APPROVED") {
    actions.push("approve");
  }

  if (status === "NEEDS_HUMAN") {
    actions.push("retry", "approve", "cancel");
  }

  if (status === "DONE" || status === "CANCELLED") {
    actions.push("retry");
  }

  return actions;
}

export function isControlAllowed(status: TaskStatus, action: ControlAction): boolean {
  return allowedControlActions(status).includes(action);
}

/** Why a control action was refused, for a precise HTTP error. */
export type ControlRefusal =
  | { code: "terminal"; message: string }
  | { code: "not_paused"; message: string }
  | { code: "already_running"; message: string }
  | { code: "invalid_transition"; message: string }
  | { code: "already_running_worker"; message: string };

/**
 * Explains a refusal in the operator's terms. Kept next to the matrix so the
 * message and the rule cannot drift apart.
 */
export function explainRefusal(status: TaskStatus, action: ControlAction): ControlRefusal {
  if (TERMINAL.includes(status) && action !== "retry") {
    return { code: "terminal", message: `Task is ${status}; only Retry is available` };
  }
  if (action === "resume" && status !== "PAUSED") {
    return { code: "not_paused", message: `Task is ${status}, not PAUSED` };
  }
  if (action === "pause" && !PAUSABLE.includes(status)) {
    return { code: "invalid_transition", message: `A ${status} task cannot be paused` };
  }
  if (action === "start" && status !== "PENDING") {
    return { code: "already_running", message: `Task is already ${status}` };
  }
  if (action === "retry" && !RETRYABLE.includes(status)) {
    return {
      code: "invalid_transition",
      message: `Task is ${status}; only a stopped task can be retried`,
    };
  }
  return {
    code: "invalid_transition",
    message: `${action} is not available while the task is ${status}`,
  };
}

// ---------------------------------------------------------------------------
// Cooperative interruption
// ---------------------------------------------------------------------------

/** What a human asked for while a run was in flight. */
export type InterruptIntent = "pause" | "cancel";

export interface InterruptRequest {
  intent: InterruptIntent;
  reason: string;
  /** Who asked (always a human for now, but kept explicit for the audit log). */
  actor?: string;
  requestedAt?: string;
}

/**
 * Raised at a safe point inside a run when a human requested pause/cancel.
 *
 * It must propagate out of agent loops rather than being turned into an agent
 * failure: a paused task is not a failed coder. Agents rethrow it explicitly for
 * that reason.
 */
export class TaskInterruptError extends Error {
  readonly request: InterruptRequest;

  constructor(request: InterruptRequest) {
    super(`Task run interrupted by ${request.actor ?? "human"}: ${request.intent} (${request.reason})`);
    this.name = "TaskInterruptError";
    this.request = request;
  }
}

export function isTaskInterrupt(error: unknown): error is TaskInterruptError {
  return error instanceof TaskInterruptError;
}

/**
 * Safe points where an interrupt may be raised.
 *
 * Deliberately coarse: between agent turns and before each tool execution. A
 * model call already in flight is allowed to finish, which keeps the persisted
 * evidence (tool calls, file changes) consistent with the state we record.
 */
export const INTERRUPT_SAFE_POINTS = ["before-agent-call", "before-tool-call", "before-review-pass"] as const;
export type InterruptSafePoint = (typeof INTERRUPT_SAFE_POINTS)[number];
