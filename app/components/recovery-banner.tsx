"use client";

/**
 * Stale-run banner.
 *
 * Surfaces abandoned runs the moment the dashboard loads, with a one-click
 * recovery action. Recovery is always an explicit operator decision: nothing here
 * deletes a run or marks a task DONE.
 */

import * as React from "react";
import Link from "next/link";

import { Button, Panel, PanelBody } from "./ui.js";
import { apiPost, useApi } from "../lib/use-api.js";
import type { ControlOutcome } from "../../src/dashboard/service.js";

export interface RecoveryReport {
  staleCount: number;
  thresholdSeconds: number;
  taskIds: string[];
}

export function RecoveryBanner({ onRecovered }: { onRecovered?: () => void }) {
  const { data, refresh } = useApi<RecoveryReport>("/api/recovery");
  const [busy, setBusy] = React.useState<string | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [notice, setNotice] = React.useState<string | undefined>(undefined);

  const recover = async (taskId: string): Promise<void> => {
    setBusy(taskId);
    setError(undefined);
    setNotice(undefined);

    const result = await apiPost<ControlOutcome>(`/api/tasks/${encodeURIComponent(taskId)}/recover`, {});
    setBusy(undefined);

    if (!result.ok) {
      setError(result.error ?? "Recovery failed.");
      return;
    }
    setNotice(result.data?.message ?? `Recovered ${taskId}`);
    refresh();
    onRecovered?.();
  };

  if (!data || data.staleCount === 0) return null;

  return (
    <Panel className="border-[var(--danger)] bg-[var(--danger-soft)]">
      <PanelBody className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold text-[var(--danger)]">
            {data.staleCount} task(s) look abandoned
          </span>
          <span className="text-[10px] text-[var(--content-muted)]">
            no heartbeat for more than {data.thresholdSeconds}s
          </span>
        </div>

        <p className="text-[10px] leading-relaxed text-[var(--content-muted)]">
          A run may be dead (its process is gone). Recovery marks the run INTERRUPTED, releases any agents stuck on
          it, and hands the task back for a decision. Nothing is deleted and no task is marked done.
        </p>

        <ul className="space-y-1">
          {data.taskIds.map((taskId) => (
            <li key={taskId} className="flex flex-wrap items-center gap-2">
              <Link
                href={`/tasks/${encodeURIComponent(taskId)}`}
                className="font-mono text-[11px] text-[var(--content)] underline decoration-dotted underline-offset-2"
              >
                {taskId}
              </Link>
              <Button type="button" variant="outline" disabled={busy !== undefined} onClick={() => void recover(taskId)}>
                {busy === taskId ? "Recovering…" : "Recover"}
              </Button>
            </li>
          ))}
        </ul>

        {notice ? <p className="text-[11px] text-[var(--ok)]">{notice}</p> : null}
        {error ? <p className="text-[11px] text-[var(--danger)]">{error}</p> : null}
      </PanelBody>
    </Panel>
  );
}
