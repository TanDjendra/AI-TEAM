"use client";

/** Tasks index: the board plus a compact table for scanning. */

import * as React from "react";
import Link from "next/link";

import { TaskBoard } from "../components/task-board.js";
import { CreateTaskForm } from "../components/create-task-form.js";
import { Badge, EmptyState, ErrorState, Panel, PanelBody, PanelHeader, PanelTitle, SkeletonRows, Td, Th } from "../components/ui.js";
import { formatDuration, formatRelative } from "../lib/utils.js";
import { taskTone } from "../lib/status.js";
import { useApi } from "../lib/use-api.js";
import type { TaskView } from "../../src/dashboard/service.js";

export default function TasksPage() {
  const { data, error, loading, refresh } = useApi<TaskView[]>("/api/tasks");
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const tasks = data ?? [];

  return (
    <div className="space-y-3 p-3 lg:p-4">
      <CreateTaskForm onCreated={refresh} />

      <Panel>
        <PanelHeader>
          <PanelTitle>Task board</PanelTitle>
          <span className="text-[10px] text-[var(--content-faint)]">{tasks.length} task(s)</span>
        </PanelHeader>
        <PanelBody className="p-0">
          {loading && !data ? (
            <div className="p-4">
              <SkeletonRows rows={3} />
            </div>
          ) : error ? (
            <div className="p-4">
              <ErrorState message="Could not load tasks." detail={error} />
            </div>
          ) : (
            <div className="p-3">
              <TaskBoard tasks={tasks} now={now} />
            </div>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>All tasks</PanelTitle>
        </PanelHeader>
        <PanelBody className="p-0">
          {tasks.length === 0 ? (
            <EmptyState title="No tasks yet" description="Create a task above to get started." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>Task</Th>
                    <Th>Title</Th>
                    <Th>Status</Th>
                    <Th>Agent</Th>
                    <Th>Cycle</Th>
                    <Th>Duration</Th>
                    <Th>Updated</Th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => {
                    const duration =
                      task.startedAt && task.completedAt
                        ? Date.parse(task.completedAt) - Date.parse(task.startedAt)
                        : undefined;
                    return (
                      <tr key={task.id}>
                        <Td>
                          <Link
                            href={`/tasks/${encodeURIComponent(task.externalId)}`}
                            className="font-mono text-[10px] font-semibold underline decoration-dotted underline-offset-2"
                          >
                            {task.externalId}
                          </Link>
                        </Td>
                        <Td>
                          <span className="block max-w-[26rem] truncate" title={task.title}>
                            {task.title}
                          </span>
                        </Td>
                        <Td>
                          <Badge tone={taskTone(task.status)} dot>
                            {task.status}
                          </Badge>
                        </Td>
                        <Td>{task.assignedAgentName ?? "—"}</Td>
                        <Td>
                          {task.currentCycle}/{task.maxReviewCycles}
                        </Td>
                        <Td>{formatDuration(duration)}</Td>
                        <Td>{formatRelative(task.updatedAt, now)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
