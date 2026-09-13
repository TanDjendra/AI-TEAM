"use client";

/**
 * Task control panel (PHASE 6).
 *
 * The button set comes from the server's control table via
 * `GET /api/tasks/:id/capabilities`, so the UI can never offer an action the API
 * would refuse. Every action POSTs to a real endpoint; none of them mutate React
 * state on their own.
 *
 * Destructive or irreversible actions (Cancel, Manual approve, Recover) go
 * through a confirmation dialog that also collects the note stored in the audit
 * trail.
 */

import * as React from "react";

import { Badge, Button, ErrorState } from "./ui.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { apiPost } from "../lib/use-api.js";
import type { ControlOutcome, TaskView } from "../../src/dashboard/service.js";

export type ControlAction = "start" | "pause" | "resume" | "cancel" | "retry" | "approve" | "recover";

const LABELS: Record<ControlAction, string> = {
  start: "Start",
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  retry: "Retry",
  approve: "Manual approve",
  recover: "Recover",
};

const VARIANTS: Record<ControlAction, "primary" | "outline" | "danger" | "ok"> = {
  start: "primary",
  pause: "outline",
  resume: "primary",
  cancel: "danger",
  retry: "outline",
  approve: "ok",
  recover: "outline",
};

/** Actions that need a confirmation step, with the copy shown for each. */
const CONFIRMATION: Partial<
  Record<ControlAction, { title: string; description: string; confirmLabel: string; destructive: boolean; requireNote: boolean }>
> = {
  cancel: {
    title: "Cancel this task?",
    description:
      "The running work is asked to stop at its next safe point. The task becomes CANCELLED and cannot continue without an explicit Retry. The reason is recorded in the audit trail.",
    confirmLabel: "Cancel task",
    destructive: true,
    requireNote: false,
  },
  approve: {
    title: "Approve on behalf of the project owner?",
    description:
      "This OVERRIDES the AI reviewer and marks the task DONE. It is recorded as a human action — distinct from an AI approval — together with the reviewer's verdict at this moment. The stored review is never modified.",
    confirmLabel: "Approve manually",
    destructive: true,
    requireNote: true,
  },
  recover: {
    title: "Recover this task?",
    description:
      "Use this when a run is dead (its process is gone). Any run still marked RUNNING is marked INTERRUPTED, agents stuck on this task are released, and the task is handed back for a decision. Nothing is deleted.",
    confirmLabel: "Recover task",
    destructive: false,
    requireNote: false,
  },
};

export interface ControlPanelProps {
  task: TaskView;
  /** Server-computed capabilities; when absent, only non-execution actions show. */
  actions?: ControlAction[];
  running?: boolean;
  stale?: boolean;
  /** Called with the authoritative task from the API after a successful action. */
  onUpdated?: (task: TaskView) => void;
  /** Called after an action that the worker applies asynchronously. */
  onRefresh?: () => void;
  className?: string;
}

export function ControlPanel({
  task,
  actions,
  running,
  stale,
  onUpdated,
  onRefresh,
  className,
}: ControlPanelProps) {
  const [busy, setBusy] = React.useState<ControlAction | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [notice, setNotice] = React.useState<string | undefined>(undefined);
  const [pending, setPending] = React.useState<ControlAction | undefined>(undefined);

  // Actions decided locally when the server has not supplied capabilities.
  const available: ControlAction[] = actions ?? fallbackActions(task.status);

  // Recovery is offered when the task looks abandoned, independently of status.
  const withRecovery: ControlAction[] = stale && !available.includes("recover")
    ? [...available, "recover"]
    : available;

  const execute = async (action: ControlAction, note: string): Promise<void> => {
    setBusy(action);
    setError(undefined);
    setNotice(undefined);

    const result = await apiPost<ControlOutcome>(
      `/api/tasks/${encodeURIComponent(task.externalId)}/${action}`,
      note ? { reason: note } : {},
    );

    setBusy(undefined);
    setPending(undefined);

    if (!result.ok) {
      setError(result.error ?? "The action failed.");
      if (action === "approve" || action === "cancel" || action === "recover") setPending(action);
      return;
    }

    setNotice(result.data?.message ?? "Action accepted.");
    if (result.data?.task) onUpdated?.(result.data.task);
    // A cooperative action is applied by the worker later: refetch to converge.
    if (result.data?.pending) onRefresh?.();
  };

  const request = (action: ControlAction): void => {
    const confirmation = CONFIRMATION[action];
    if (confirmation) {
      setPending(action);
      return;
    }
    void execute(action, "");
  };

  const pendingConfirmation = pending ? CONFIRMATION[pending] : undefined;

  if (withRecovery.length === 0) {
    return (
      <div className={className}>
        <p className="text-[11px] text-[var(--content-faint)]">
          No control actions available in state {task.status}.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        {withRecovery.map((action) => (
          <Button
            key={action}
            type="button"
            variant={VARIANTS[action]}
            disabled={busy !== undefined}
            onClick={() => request(action)}
          >
            {busy === action ? "Working…" : LABELS[action]}
          </Button>
        ))}

        {running ? <Badge tone="coder" dot>running in this process</Badge> : null}
        {stale ? <Badge tone="danger" dot>stale run</Badge> : null}
      </div>

      {notice ? (
        <p className="mt-2 text-[11px] text-[var(--ok)]" role="status">
          {notice}
        </p>
      ) : null}

      {error ? (
        <div className="mt-2">
          <ErrorState message={error} />
        </div>
      ) : null}

      <ConfirmDialog
        open={pending !== undefined && pendingConfirmation !== undefined && error === undefined}
        title={pendingConfirmation?.title ?? ""}
        description={pendingConfirmation?.description ?? ""}
        withNote
        requireNote={pendingConfirmation?.requireNote ?? false}
        confirmLabel={pendingConfirmation?.confirmLabel}
        destructive={pendingConfirmation?.destructive ?? false}
        busy={busy !== undefined}
        {...(error ? { error } : {})}
        onConfirm={(note) => {
          if (pending) void execute(pending, note);
        }}
        onCancel={() => {
          setPending(undefined);
          setError(undefined);
        }}
      />
    </div>
  );
}

/** Mirrors the server control table, used only when capabilities are unavailable. */
export function fallbackActions(status: TaskView["status"]): ControlAction[] {
  switch (status) {
    case "PENDING":
      return ["start", "cancel"];
    case "CODING":
    case "TESTING":
    case "REVIEW":
    case "FIXING":
    case "REJECTED":
      return ["pause", "cancel"];
    case "PAUSED":
      return ["resume", "cancel"];
    case "APPROVED":
      return ["approve"];
    case "NEEDS_HUMAN":
      return ["retry", "approve", "cancel"];
    case "DONE":
    case "CANCELLED":
      return ["retry"];
    default:
      return [];
  }
}
