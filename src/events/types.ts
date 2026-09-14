/**
 * Typed event model.
 *
 * The database is the source of truth; events are the *change feed*. Every event
 * carries a globally unique `id` which doubles as the idempotency key, so a
 * redelivered event can never produce a duplicate transition.
 *
 * Event types are a closed union: adding a new one is a compile error everywhere
 * that switches on `type` until it is handled.
 */

import type { CoderStatus, ReviewSeverity, ReviewVerdict, TaskSpec } from "../domain/types.js";

export const TASK_EVENT_TYPES = [
  "TASK_CREATED",
  "TASK_ASSIGNED",
  "TASK_STARTED",
  "STATE_CHANGED",
  "AGENT_STARTED",
  "AGENT_FINISHED",
  "TOOL_STARTED",
  "TOOL_FINISHED",
  "FILE_CHANGED",
  "TEST_STARTED",
  "TEST_FINISHED",
  "SUBMITTED_FOR_REVIEW",
  "REVIEW_STARTED",
  "REVIEW_FINISHED",
  "REVIEW_REJECTED",
  "FIX_STARTED",
  "TASK_APPROVED",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "TASK_PAUSED",
  "TASK_RESUMED",
  "TASK_CANCELLED",
  // PHASE 6: human control + recovery.
  "TASK_STALE",
  "HUMAN_STARTED_TASK",
  "HUMAN_PAUSED_TASK",
  "HUMAN_RESUMED_TASK",
  "HUMAN_CANCELLED_TASK",
  "HUMAN_RETRIED_TASK",
  "HUMAN_APPROVED_TASK",
  // Phase V2-04: Workflow DAG events
  "WORKFLOW_CREATED",
  "WORKFLOW_VALIDATED",
  "WORKFLOW_VALIDATION_FAILED",
  "WORKFLOW_STARTED",
  "WORKFLOW_SUCCEEDED",
  "WORKFLOW_FAILED",
  "WORKFLOW_CANCELLED",
  // Node lifecycle events
  "WORKFLOW_NODE_READY",
  "WORKFLOW_NODE_CLAIMED",
  "WORKFLOW_NODE_RUNNING",
  "WORKFLOW_NODE_SUCCEEDED",
  "WORKFLOW_NODE_BLOCKED",
  "WORKFLOW_NODE_CANCELLED",
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

/** Task lifecycle status as persisted. Mirrors the state machine, plus PAUSED. */
export type TaskStatus =
  | "PENDING"
  | "CODING"
  | "TESTING"
  | "REVIEW"
  | "REJECTED"
  | "FIXING"
  | "APPROVED"
  | "DONE"
  | "NEEDS_HUMAN"
  | "PAUSED"
  | "CANCELLED";

export type AgentRole = "coder" | "reviewer";

/** Per-type event payloads. */
export interface TaskEventPayloadMap {
  TASK_CREATED: {
    title: string;
    description: string;
    workspace: string;
    maxReviewCycles: number;
    acceptanceCriteria: string[];
  };
  TASK_ASSIGNED: {
    agentId: string;
    role: AgentRole;
    provider: string;
    model: string;
    cycle: number;
  };
  TASK_STARTED: {
    workspace: string;
    maxReviewCycles: number;
  };
  STATE_CHANGED: {
    from: TaskStatus;
    to: TaskStatus;
    cycle: number;
    /** Present when the transition was forced by policy (e.g. budget). */
    reason?: string;
  };
  AGENT_STARTED: {
    agentId: string;
    role: AgentRole;
    model: string;
    cycle: number;
    attempt: number;
    runReason: "INITIAL" | "FIX";
  };
  AGENT_FINISHED: {
    agentId: string;
    role: AgentRole;
    ok: boolean;
    durationMs: number;
    resolvedModel?: string;
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    /** Not persisted to activity_logs; kept for transports that want it. */
    error?: string;
  };
  TOOL_STARTED: {
    toolCallId: string;
    tool: string;
    arguments: Record<string, unknown>;
    agentId: string;
    cycle: number;
  };
  TOOL_FINISHED: {
    toolCallId: string;
    tool: string;
    agentId: string;
    cycle: number;
    success: boolean;
    durationMs: number;
    exitCode?: number | null;
    outputSummary: string;
  };
  FILE_CHANGED: {
    agentId: string;
    path: string;
    changeType: "created" | "modified" | "deleted";
    summary: string;
    gitBaseHash?: string;
  };
  TEST_STARTED: {
    agentId: string;
    testKey: string;
    command: string;
    cycle: number;
  };
  TEST_FINISHED: {
    agentId: string;
    testKey: string;
    command: string;
    cycle: number;
    exitCode: number | null;
    passed: boolean;
    durationMs: number;
    outputSummary: string;
    /** True when the harness treats this as the authoritative test run. */
    authoritative: boolean;
  };
  SUBMITTED_FOR_REVIEW: {
    cycle: number;
    coderStatus: CoderStatus;
    filesChanged: number;
    testsPassed: boolean;
  };
  REVIEW_STARTED: {
    reviewer: string;
    cycle: number;
    attempt: number;
  };
  REVIEW_FINISHED: {
    reviewer: string;
    cycle: number;
    verdict: ReviewVerdict;
    severity: ReviewSeverity;
    issues: string[];
    requiredFixes: string[];
    summary: string;
  };
  REVIEW_REJECTED: {
    cycle: number;
    severity: ReviewSeverity;
    requiredFixes: string[];
    /** False when there is no budget left for another pass. */
    willRetry: boolean;
  };
  FIX_STARTED: {
    cycle: number;
    attempt: number;
    requiredFixes: string[];
  };
  TASK_APPROVED: {
    cycle: number;
    severity: ReviewSeverity;
    reviewer: string;
  };
  TASK_COMPLETED: {
    cycles: number;
    durationMs: number;
  };
  TASK_FAILED: {
    stopReason: string;
    message: string;
  };
  TASK_PAUSED: { reason: string };
  TASK_RESUMED: { reason: string };
  TASK_CANCELLED: { reason: string };
  /**
   * A run stopped heartbeating: its owning process is gone while the run is
   * still marked RUNNING. Recorded, never auto-deleted — a human decides.
   */
  TASK_STALE: {
    runId: string;
    staleForMs: number;
    thresholdMs: number;
    /** What recovery did about it. */
    recovery: "MARKED_INTERRUPTED" | "DETECTED_ONLY";
    message: string;
  };
  /**
   * Human control actions.
   *
   * These are distinct event types on purpose: an audit trail must make it
   * obvious that a *person* acted, never that the reviewer approved or the coder
   * started something on its own.
   */
  HUMAN_STARTED_TASK: HumanActionPayload;
  HUMAN_PAUSED_TASK: HumanActionPayload;
  HUMAN_RESUMED_TASK: HumanActionPayload;
  HUMAN_CANCELLED_TASK: HumanActionPayload;
  HUMAN_RETRIED_TASK: HumanActionPayload;
  HUMAN_APPROVED_TASK: HumanActionPayload & {
    /** The previous status the human overrode. */
    fromStatus: TaskStatus;
    /** Always true: distinguishes a human override from an AI verdict. */
    manual: true;
    /**
     * The reviewer's verdict at the time, when one existed. Recorded so the
     * override is visible as a disagreement rather than a rewrite.
     */
    reviewerVerdict?: string;
  };

  // ── Phase V2-04: Workflow DAG events ────────────────────────────────────

  /** WorkflowSpec persisted; status = DRAFT. */
  WORKFLOW_CREATED: {
    workflowId: string;
    objective: string;
    nodeCount: number;
    edgeCount: number;
    workspaceSlug?: string;
    workspacePath?: string;
  };

  /** WorkflowValidator passed; status → VALIDATED. */
  WORKFLOW_VALIDATED: {
    workflowId: string;
  };

  /** WorkflowValidator rejected the spec. */
  WORKFLOW_VALIDATION_FAILED: {
    workflowId: string;
    errors: Array<{ code: string; message: string; nodes?: string[] }>;
  };

  /** First node transitioned to CLAIMED or RUNNING. */
  WORKFLOW_STARTED: {
    workflowId: string;
  };

  /** All nodes reached SUCCEEDED. */
  WORKFLOW_SUCCEEDED: {
    workflowId: string;
    durationMs: number;
  };

  /** One or more nodes became permanently BLOCKED. */
  WORKFLOW_FAILED: {
    workflowId: string;
    blockedNodeKeys: string[];
    reason: string;
  };

  /** Human-cancelled the whole workflow. */
  WORKFLOW_CANCELLED: {
    workflowId: string;
    reason: string;
  };

  // ── Node lifecycle events ────────────────────────────────────────────────

  /** All predecessor nodes SUCCEEDED; node transitions WAITING_DEPENDENCIES → READY. */
  WORKFLOW_NODE_READY: {
    workflowId: string;
    nodeKey: string;
  };

  /** Scheduler reserved the node; V1 tasks row materialised. */
  WORKFLOW_NODE_CLAIMED: {
    workflowId: string;
    nodeKey: string;
    taskId: string;
  };

  /** Associated V1 task entered a running state. */
  WORKFLOW_NODE_RUNNING: {
    workflowId: string;
    nodeKey: string;
    taskId: string;
  };

  /** V1 task completed (DONE + approved = true). */
  WORKFLOW_NODE_SUCCEEDED: {
    workflowId: string;
    nodeKey: string;
    taskId: string;
  };

  /** A predecessor node was CANCELLED or BLOCKED (poison-pill propagation). */
  WORKFLOW_NODE_BLOCKED: {
    workflowId: string;
    nodeKey: string;
    reason: string;
  };

  /** Node explicitly cancelled before or during execution. */
  WORKFLOW_NODE_CANCELLED: {
    workflowId: string;
    nodeKey: string;
    reason: string;
  };
}

/** Shared shape for every human-originated event. */
export interface HumanActionPayload {
  /** Always "human" — the audit trail's discriminator. */
  actor: "human";
  action: string;
  taskId: string;
  /** ISO timestamp of the action, as recorded by the server. */
  timestamp: string;
  /** Free-form note the operator supplied. */
  note?: string;
  /** Status before the action, so the change is unambiguous in the journal. */
  fromStatus?: TaskStatus;
  /** Status after the action. */
  toStatus?: TaskStatus;
}

export type TaskEventPayload<K extends TaskEventType> = TaskEventPayloadMap[K];

/** Where an event came from. Useful when several producers share one table. */
export interface EventContext {
  taskId: string;
  agentId?: string;
  cycle?: number;
  /**
   * Phase V2-04: present on workflow-level events.
   * Distinct from taskId — overloading taskId with a workflowId breaks
   * downstream telemetry that assumes taskId references the tasks table.
   */
  workflowId?: string;
}

/**
 * The persisted/realtime event shape.
 *
 * `cycle` and `agentId` are duplicated at the top level (they also appear inside
 * some payloads) so a dashboard can filter without parsing payload JSON.
 */
export interface TaskEvent<K extends TaskEventType = TaskEventType> {
  id: string;
  type: K;
  taskId: string;
  agentId?: string;
  cycle?: number;
  timestamp: string;
  payload: TaskEventPayload<K>;
}

/** A fully-typed union over every concrete event, for exhaustive handling. */
export type AnyTaskEvent = { [K in TaskEventType]: TaskEvent<K> }[TaskEventType];

/** Narrowing helper: does this event carry the given type? */
export function isEventOfType<K extends TaskEventType>(
  event: AnyTaskEvent,
  type: K,
): boolean {
  return event.type === type;
}

/** Events that mean "the run is over" — used by recovery/status queries. */
export const TERMINAL_EVENT_TYPES: readonly TaskEventType[] = [
  "TASK_COMPLETED",
  "TASK_FAILED",
  "TASK_CANCELLED",
];

export function isTerminalEvent(type: TaskEventType): boolean {
  return TERMINAL_EVENT_TYPES.includes(type);
}

/** Re-exported so event consumers do not need to reach into the domain layer. */
export type { TaskSpec };
