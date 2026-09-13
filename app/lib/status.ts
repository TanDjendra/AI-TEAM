/**
 * Status vocabulary and colour mapping.
 *
 * One place decides what a status looks like, so the agent cards, task board and
 * timeline agree. Colours come from the CSS variables in globals.css, so light
 * and dark are handled by the theme rather than here.
 */

import type { AgentStatus } from "../../src/persistence/repositories/agent-repository.js";
import type { TaskStatus } from "../../src/events/types.js";

export type ToneKey = "ok" | "warn" | "danger" | "info" | "neutral" | "coder" | "reviewer";

export const TONE_STYLES: Record<ToneKey, { text: string; bg: string; border: string; dot: string }> = {
  ok: { text: "text-[var(--ok)]", bg: "bg-[var(--ok-soft)]", border: "border-[var(--ok)]", dot: "bg-[var(--ok)]" },
  warn: { text: "text-[var(--warn)]", bg: "bg-[var(--warn-soft)]", border: "border-[var(--warn)]", dot: "bg-[var(--warn)]" },
  danger: { text: "text-[var(--danger)]", bg: "bg-[var(--danger-soft)]", border: "border-[var(--danger)]", dot: "bg-[var(--danger)]" },
  info: { text: "text-[var(--info)]", bg: "bg-[var(--info-soft)]", border: "border-[var(--info)]", dot: "bg-[var(--info)]" },
  neutral: { text: "text-[var(--content-muted)]", bg: "bg-[var(--neutral-soft)]", border: "border-[var(--border-subtle)]", dot: "bg-[var(--content-faint)]" },
  coder: { text: "text-[var(--coder)]", bg: "bg-[var(--coder-soft)]", border: "border-[var(--coder)]", dot: "bg-[var(--coder)]" },
  reviewer: { text: "text-[var(--reviewer)]", bg: "bg-[var(--reviewer-soft)]", border: "border-[var(--reviewer)]", dot: "bg-[var(--reviewer)]" },
};

const AGENT_TONES: Record<AgentStatus, ToneKey> = {
  IDLE: "neutral",
  WORKING: "coder",
  REVIEWING: "reviewer",
  ERROR: "danger",
  OFFLINE: "neutral",
};

export function agentTone(status: AgentStatus): ToneKey {
  return AGENT_TONES[status] ?? "neutral";
}

const TASK_TONES: Record<TaskStatus, ToneKey> = {
  PENDING: "neutral",
  CODING: "coder",
  TESTING: "info",
  REVIEW: "reviewer",
  REJECTED: "danger",
  FIXING: "warn",
  APPROVED: "ok",
  DONE: "ok",
  NEEDS_HUMAN: "danger",
  PAUSED: "warn",
  CANCELLED: "neutral",
};

export function taskTone(status: TaskStatus | string): ToneKey {
  return TASK_TONES[status as TaskStatus] ?? "neutral";
}

const SEVERITY_TONES: Record<string, ToneKey> = {
  NONE: "ok",
  LOW: "info",
  MEDIUM: "warn",
  HIGH: "danger",
  CRITICAL: "danger",
};

export function severityTone(severity: string): ToneKey {
  return SEVERITY_TONES[severity.toUpperCase()] ?? "neutral";
}

/** Board column order — the lifecycle as the owner reads it, plus the exits. */
export const BOARD_COLUMNS: Array<{ status: TaskStatus; label: string; hint: string }> = [
  { status: "PENDING", label: "Pending", hint: "Queued, not started" },
  { status: "CODING", label: "Coding", hint: "Coder is implementing" },
  { status: "TESTING", label: "Testing", hint: "Test run recorded" },
  { status: "REVIEW", label: "Review", hint: "Reviewer is judging" },
  { status: "FIXING", label: "Fixing", hint: "Coder addresses review" },
  { status: "DONE", label: "Done", hint: "Approved and complete" },
  { status: "NEEDS_HUMAN", label: "Needs human", hint: "Stopped, needs an owner" },
  { status: "PAUSED", label: "Paused", hint: "Paused by the owner" },
  { status: "CANCELLED", label: "Cancelled", hint: "Cancelled by the owner" },
];

/** Events that matter for the live feed; everything else is still stored. */
export const NOTABLE_EVENT_TONES: Record<string, ToneKey> = {
  TASK_CREATED: "info",
  TASK_STARTED: "info",
  STATE_CHANGED: "neutral",
  AGENT_STARTED: "info",
  AGENT_FINISHED: "neutral",
  TOOL_STARTED: "neutral",
  TOOL_FINISHED: "neutral",
  FILE_CHANGED: "neutral",
  TEST_FINISHED: "info",
  SUBMITTED_FOR_REVIEW: "info",
  REVIEW_FINISHED: "reviewer",
  REVIEW_REJECTED: "danger",
  FIX_STARTED: "warn",
  TASK_APPROVED: "ok",
  TASK_COMPLETED: "ok",
  TASK_FAILED: "danger",
  TASK_PAUSED: "warn",
  TASK_RESUMED: "info",
  TASK_CANCELLED: "neutral",
  // PHASE 6
  TASK_STALE: "danger",
  HUMAN_STARTED_TASK: "info",
  HUMAN_PAUSED_TASK: "warn",
  HUMAN_RESUMED_TASK: "info",
  HUMAN_CANCELLED_TASK: "neutral",
  HUMAN_RETRIED_TASK: "warn",
  HUMAN_APPROVED_TASK: "ok",
};

export function eventTone(eventType: string): ToneKey {
  return NOTABLE_EVENT_TONES[eventType] ?? "neutral";
}
