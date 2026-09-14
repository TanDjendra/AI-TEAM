"use client";

import * as React from "react";
import Link from "next/link";
import { Badge } from "./ui.js";
import { cn, formatRelative } from "../lib/utils.js";
import type { WorkflowView } from "../../src/dashboard/service.js";

const WORKFLOW_COLUMNS = [
  { status: "PENDING", label: "Pending", hint: "Waiting to be picked up" },
  { status: "RUNNING", label: "Running", hint: "Currently executing" },
  { status: "BLOCKED", label: "Blocked", hint: "Waiting for human or recovery" },
  { status: "DONE", label: "Done", hint: "Completed successfully" },
  { status: "FAILED", label: "Failed", hint: "Failed execution" },
] as const;

export function workflowTone(status: string) {
  switch (status) {
    case "PENDING":
      return "neutral";
    case "RUNNING":
      return "info";
    case "BLOCKED":
      return "warn";
    case "DONE":
      return "ok";
    case "FAILED":
      return "danger";
    default:
      return "neutral";
  }
}

export function WorkflowCard({ workflow, now }: { workflow: WorkflowView; now: number }) {
  return (
    <Link
      href={`/workflows/${encodeURIComponent(workflow.id)}`}
      className={cn(
        "block rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-2.5",
        "transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-raised)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11px] font-semibold text-[var(--content)]">{workflow.id}</span>
        <Badge tone={workflowTone(workflow.status)}>{workflow.status}</Badge>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-[var(--content-faint)]">
        <span className="truncate">Auto-generated Workflow</span>
      </div>
      <div className="mt-1 text-[10px] text-[var(--content-faint)]">{formatRelative(workflow.updatedAt, now)}</div>
    </Link>
  );
}

export interface WorkflowBoardProps {
  workflows: WorkflowView[];
  now: number;
}

export function WorkflowBoard({ workflows, now }: WorkflowBoardProps) {
  const byStatus = React.useMemo(() => {
    const map = new Map<string, WorkflowView[]>();
    for (const wf of workflows) {
      const bucket = map.get(wf.status) ?? [];
      bucket.push(wf);
      map.set(wf.status, bucket);
    }
    return map;
  }, [workflows]);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {WORKFLOW_COLUMNS.map((column) => {
        const columnWorkflows = byStatus.get(column.status) ?? [];
        return (
          <section
            key={column.status}
            aria-label={column.label}
            className="flex w-[200px] shrink-0 flex-col rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)]"
          >
            <header className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-2.5 py-2">
              <div className="min-w-0">
                <div className="truncate text-[11px] font-semibold text-[var(--content)]">{column.label}</div>
                <div className="truncate text-[10px] text-[var(--content-faint)]" title={column.hint}>
                  {column.hint}
                </div>
              </div>
              <span className="shrink-0 rounded bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--content-muted)]">
                {columnWorkflows.length}
              </span>
            </header>

            <div className="flex flex-1 flex-col gap-2 p-2">
              {columnWorkflows.length === 0 ? (
                <p className="px-1 py-3 text-center text-[10px] text-[var(--content-faint)]">empty</p>
              ) : (
                columnWorkflows.map((wf) => <WorkflowCard key={wf.id} workflow={wf} now={now} />)
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
