/**
 * Human-readable rendering of domain events.
 *
 * The live feed and the task timeline both read from this module, so a message
 * is phrased identically everywhere. It only uses fields the event actually
 * carries — nothing is inferred or invented, and a missing payload degrades to
 * the event type rather than to a made-up sentence.
 *
 * Pure functions, no React: the tests exercise this directly.
 */

import type { AnyTaskEvent } from "../../src/events/types.js";

export interface EventDescription {
  /** Who acted, as shown to the operator ("DeepSeek", "GPT Luna", "Owner"). */
  actor: string;
  /** One line describing what happened. */
  message: string;
  /** Extra context worth showing in a dense list (path, verdict, count). */
  detail?: string;
}

const AGENT_LABELS: Record<string, string> = {
  coder: "DeepSeek",
  reviewer: "GPT Luna",
  "coder-agent": "DeepSeek",
  "reviewer-agent": "GPT Luna",
  owner: "Owner",
  system: "Orchestrator",
  orchestrator: "Orchestrator",
};

/** Agent keys arrive as "coder"/"reviewer"; ids may be UUIDs. */
export function agentLabel(raw: string | undefined): string {
  if (!raw) return "Orchestrator";
  const mapped = AGENT_LABELS[raw] ?? AGENT_LABELS[raw.toLowerCase()];
  if (mapped) return mapped;
  // An agent UUID we cannot resolve to a key: show a short form.
  return raw.length > 12 ? `${raw.slice(0, 8)}…` : raw;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The operator's note, when present. */
function noteOf(payload: Record<string, unknown>): string | undefined {
  return str(payload.note) ?? str(payload.reason);
}

export function describeEvent(event: AnyTaskEvent): EventDescription {
  const payload = asRecord(event.payload);
  const actor = agentLabel(event.agentId ?? undefined);

  switch (event.type) {
    case "TASK_CREATED": {
      const title = str(payload.title);
      return { actor: "Owner", message: title ? `created task “${title}”` : "created a task" };
    }

    case "TASK_ASSIGNED": {
      const role = str(payload.role) ?? "coder";
      return { actor: "Orchestrator", message: `assigned the task to ${agentLabel(role)}` };
    }

    case "TASK_STARTED":
      return { actor: "Orchestrator", message: "started the task" };

    case "STATE_CHANGED": {
      const from = str(payload.from) ?? "?";
      const to = str(payload.to) ?? "?";
      const reason = str(payload.reason);
      const cycle = num(payload.reviewCycles);
      return {
        actor: "Orchestrator",
        message: `${from} → ${to}`,
        ...(reason || cycle !== undefined
          ? { detail: [reason, cycle !== undefined ? `cycle ${cycle}` : undefined].filter(Boolean).join(" · ") }
          : {}),
      };
    }

    case "AGENT_STARTED":
      return { actor, message: "started working" };

    case "AGENT_FINISHED": {
      const status = str(payload.status);
      const durationMs = num(payload.durationMs);
      return {
        actor,
        message: status ? `finished (${status})` : "finished",
        ...(durationMs !== undefined ? { detail: `${(durationMs / 1000).toFixed(1)}s` } : {}),
      };
    }

    case "TOOL_STARTED":
      return { actor, message: `called ${str(payload.tool) ?? "a tool"}` };

    case "TOOL_FINISHED": {
      const tool = str(payload.tool) ?? "tool";
      const success = payload.success;
      const exitCode = num(payload.exitCode);
      const durationMs = num(payload.durationMs);
      const parts: string[] = [];
      if (durationMs !== undefined) parts.push(`${durationMs}ms`);
      if (exitCode !== undefined) parts.push(`exit ${exitCode}`);
      return {
        actor,
        message: `${tool} ${success === false ? "failed" : "finished"}`,
        ...(parts.length ? { detail: parts.join(" · ") } : {}),
      };
    }

    case "FILE_CHANGED": {
      const path = str(payload.path) ?? "a file";
      const changeType = str(payload.changeType);
      const summary = str(payload.summary);
      // changeType is the domain vocabulary: created | modified | deleted.
      const verb = changeType === "created" ? "created" : changeType === "deleted" ? "deleted" : "wrote";
      return {
        actor,
        message: `${verb} ${path}`,
        ...(summary ? { detail: summary } : {}),
      };
    }

    case "TEST_STARTED":
      return { actor, message: "started tests", ...(str(payload.command) ? { detail: str(payload.command)! } : {}) };

    case "TEST_FINISHED": {
      const passed = payload.passed;
      const exitCode = num(payload.exitCode);
      const command = str(payload.command);
      return {
        actor,
        message: passed === false ? "tests failed" : "tests passed",
        ...(command || exitCode !== undefined
          ? { detail: [command, exitCode !== undefined ? `exit ${exitCode}` : undefined].filter(Boolean).join(" · ") }
          : {}),
      };
    }

    case "SUBMITTED_FOR_REVIEW":
      return { actor: "Orchestrator", message: "submitted the work for review" };

    case "REVIEW_STARTED":
      return { actor, message: "started review" };

    case "REVIEW_FINISHED": {
      const verdict = str(payload.verdict);
      const severity = str(payload.severity);
      const cycle = num(payload.cycle);
      return {
        actor,
        message: verdict ? `review finished: ${verdict}` : "review finished",
        ...(severity || cycle !== undefined
          ? { detail: [severity, cycle !== undefined ? `cycle ${cycle}` : undefined].filter(Boolean).join(" · ") }
          : {}),
      };
    }

    case "REVIEW_REJECTED": {
      const issues = Array.isArray(payload.issues) ? payload.issues.length : undefined;
      const severity = str(payload.severity);
      return {
        actor,
        message: "rejected the task",
        ...(severity || issues !== undefined
          ? {
              detail: [severity, issues !== undefined ? `${issues} issue${issues === 1 ? "" : "s"}` : undefined]
                .filter(Boolean)
                .join(" · "),
            }
          : {}),
      };
    }

    case "FIX_STARTED":
      return { actor, message: "started a fix cycle" };

    case "TASK_APPROVED":
      return { actor: "Orchestrator", message: "task approved" };

    case "TASK_COMPLETED":
      return { actor: "Orchestrator", message: "task completed" };

    case "TASK_FAILED":
      return {
        actor: "Orchestrator",
        message: "task failed",
        ...(str(payload.reason) ? { detail: str(payload.reason)! } : {}),
      };

    case "TASK_PAUSED":
      return { actor: "Owner", message: "paused the task", ...(str(payload.reason) ? { detail: str(payload.reason)! } : {}) };

    case "TASK_RESUMED":
      return { actor: "Owner", message: "resumed the task" };

    case "TASK_CANCELLED":
      return {
        actor: "Owner",
        message: "cancelled the task",
        ...(str(payload.reason) ? { detail: str(payload.reason)! } : {}),
      };

    // ---- PHASE 6: human control + recovery ----

    case "TASK_STALE": {
      const seconds = num(payload.staleForMs);
      const recovery = str(payload.recovery);
      return {
        actor: "Orchestrator",
        message: "detected a stale run",
        detail: [
          seconds !== undefined ? `no heartbeat ${Math.round(seconds / 1000)}s` : undefined,
          recovery === "MARKED_INTERRUPTED" ? "run marked interrupted" : "detected only",
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }

    /**
     * Human actions are phrased in the first person ("you paused …") so the feed
     * cannot be mistaken for something an agent did.
     */
    case "HUMAN_STARTED_TASK":
      return { actor: "Owner", message: "started the task", ...(noteOf(payload) ? { detail: noteOf(payload)! } : {}) };

    case "HUMAN_PAUSED_TASK":
      return { actor: "Owner", message: "requested a pause", ...(noteOf(payload) ? { detail: noteOf(payload)! } : {}) };

    case "HUMAN_RESUMED_TASK":
      return { actor: "Owner", message: "resumed the task", ...(noteOf(payload) ? { detail: noteOf(payload)! } : {}) };

    case "HUMAN_CANCELLED_TASK":
      return { actor: "Owner", message: "cancelled the task", ...(noteOf(payload) ? { detail: noteOf(payload)! } : {}) };

    case "HUMAN_RETRIED_TASK":
      return { actor: "Owner", message: "retried the task", ...(noteOf(payload) ? { detail: noteOf(payload)! } : {}) };

    case "HUMAN_APPROVED_TASK": {
      const verdict = str(payload.reviewerVerdict);
      return {
        actor: "Owner",
        message: "approved the task manually",
        detail: [
          noteOf(payload),
          verdict ? `reviewer verdict was ${verdict}` : "no reviewer verdict",
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }

    default:
      // Exhaustive in practice; kept for forward compatibility with new event
      // types the dashboard has not learned to phrase yet.
      return { actor, message: (event as { type: string }).type };
  }
}

/** Short one-liner used in tables and compact feeds. */
export function describeEventLine(event: AnyTaskEvent): string {
  const { actor, message } = describeEvent(event);
  return `${actor} ${message}`;
}
