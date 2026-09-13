"use client";

/**
 * Task board — one column per lifecycle state, fed by GET /api/tasks.
 *
 * Columns exist even when empty, so the board always shows the full pipeline and
 * an empty state is informative rather than invisible.
 */

import * as React from "react";
import Link from "next/link";

import { Badge } from "./ui.js";
import { cn, formatRelative } from "../lib/utils.js";
import { BOARD_COLUMNS, taskTone } from "../lib/status.js";
import type { TaskView } from "../../src/dashboard/service.js";

export function TaskCard({ task, now }: { task: TaskView; now: number }) {
  return (
    <Link
      href={`/tasks/${encodeURIComponent(task.externalId)}`}
      className={cn(
        "block rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-2.5",
        "transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-raised)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11px] font-semibold text-[var(--content)]">{task.externalId}</span>
        <Badge tone={taskTone(task.status)}>{task.status}</Badge>
      </div>

      <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-[var(--content-muted)]" title={task.title}>
        {task.title}
      </p>

      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-[var(--content-faint)]">
        <span className="truncate">{task.assignedAgentName ?? task.assignedAgentId ? "assigned" : "unassigned"}</span>
        <span className="shrink-0">
          cycle {task.currentCycle}/{task.maxReviewCycles}
        </span>
      </div>
      <div className="mt-1 text-[10px] text-[var(--content-faint)]">{formatRelative(task.updatedAt, now)}</div>
    </Link>
  );
}

export interface TaskBoardProps {
  tasks: TaskView[];
  now: number;
  /** When set, only this status is shown (used by the Tasks page filter). */
  filter?: string;
}

export function TaskBoard({ tasks, now }: TaskBoardProps) {
  const byStatus = React.useMemo(() => {
    const map = new Map<string, TaskView[]>();
    for (const task of tasks) {
      const bucket = map.get(task.status) ?? [];
      bucket.push(task);
      map.set(task.status, bucket);
    }
    return map;
  }, [tasks]);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {BOARD_COLUMNS.map((column) => {
        const columnTasks = byStatus.get(column.status) ?? [];
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
                {columnTasks.length}
              </span>
            </header>

            <div className="flex flex-1 flex-col gap-2 p-2">
              {columnTasks.length === 0 ? (
                <p className="px-1 py-3 text-center text-[10px] text-[var(--content-faint)]">empty</p>
              ) : (
                columnTasks.map((task) => <TaskCard key={task.id} task={task} now={now} />)
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
