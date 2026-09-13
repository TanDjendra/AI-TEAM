"use client";

/**
 * Task detail page.
 *
 * Tabs: Overview · Timeline · Runs · Reviews · Tools · Files · Tests.
 *
 * Every tab renders stored rows fetched from the task-scoped endpoints. The
 * timeline uses `activity` as returned by the API, which is ordered by
 * `publish_seq` — the deterministic ordering fixed in PHASE 4.
 */

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { Badge, EmptyState, ErrorState, Panel, PanelBody, PanelHeader, PanelTitle, Stat, Td, Th } from "../../components/ui.js";
import { ControlPanel } from "../../components/control-panel.js";
import { ReviewItem } from "../../components/review-center.js";
import { cn, formatDateTime, formatDuration, formatRelative, formatTime, prettyJson } from "../../lib/utils.js";
import { severityTone, taskTone } from "../../lib/status.js";
import { describeEvent } from "../../lib/event-text.js";
import { apiGet, useApi } from "../../lib/use-api.js";
import type { TaskDetailView, TaskView } from "../../../src/dashboard/service.js";
import type { AnyTaskEvent } from "../../../src/events/types.js";

const TABS = ["Overview", "Timeline", "Runs", "Reviews", "Tools", "Files", "Tests"] as const;
type Tab = (typeof TABS)[number];

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [tab, setTab] = React.useState<Tab>("Overview");

  const { data, error, loading, refresh } = useApi<TaskDetailView>(
    id ? `/api/tasks/${encodeURIComponent(id)}` : "/api/tasks/__missing__",
  );

  // Local override so a control action updates the header immediately; the next
  // refetch replaces it with the database's own answer.
  const [override, setOverride] = React.useState<TaskView | undefined>(undefined);
  const task = override ?? data?.task;

  // Server-computed control capabilities: the button set comes from the same
  // control table the API validates against, so the UI cannot offer an action the
  // backend would refuse.
  const capabilities = useApi<{
    status: string;
    actions: Array<"start" | "pause" | "resume" | "cancel" | "retry" | "approve" | "recover">;
    running: boolean;
    stale: boolean;
    staleForMs?: number;
  }>(id ? `/api/tasks/${encodeURIComponent(id)}/capabilities` : "/api/tasks/__missing__/capabilities");

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  if (loading && !data) {
    return <PageShell id={id}><p className="p-6 text-[11px] text-[var(--content-faint)]">Loading task…</p></PageShell>;
  }

  if (error) {
    return (
      <PageShell id={id}>
        <div className="p-6">
          <ErrorState message={`Could not load task ${id}.`} detail={error} />
        </div>
      </PageShell>
    );
  }

  if (!data || !task) {
    return (
      <PageShell id={id}>
        <div className="p-6">
          <EmptyState title="Task not found" description={`No task with id ${id}.`} />
        </div>
      </PageShell>
    );
  }

  const duration =
    task.startedAt && task.completedAt
      ? Date.parse(task.completedAt) - Date.parse(task.startedAt)
      : undefined;

  return (
    <PageShell id={id} status={task.status}>
      <div className="space-y-3 p-3 lg:p-4">
        <Panel>
          <PanelHeader>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <PanelTitle>{task.externalId}</PanelTitle>
                <Badge tone={taskTone(task.status)} dot>
                  {task.status}
                </Badge>
                {task.approved ? <Badge tone="ok">approved</Badge> : null}
                {task.stopReason ? <Badge tone="danger">stop: {task.stopReason}</Badge> : null}
              </div>
              <h2 className="mt-1 truncate text-sm font-semibold text-[var(--content)]">{task.title}</h2>
            </div>
            <Link
              href="/"
              className="shrink-0 text-[11px] text-[var(--content-muted)] underline decoration-dotted underline-offset-2"
            >
              ← Command Center
            </Link>
          </PanelHeader>

          <PanelBody className="pt-3">
            <ControlPanel
              task={task}
              {...(capabilities.data ? { actions: capabilities.data.actions } : {})}
              running={capabilities.data?.running ?? false}
              stale={capabilities.data?.stale ?? false}
              onUpdated={(updated) => {
                setOverride(updated);
                refresh();
                capabilities.refresh();
              }}
              onRefresh={() => {
                refresh();
                capabilities.refresh();
              }}
            />
          </PanelBody>
        </Panel>

        <nav className="flex flex-wrap gap-1 border-b border-[var(--border-subtle)]">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setTab(name)}
              aria-current={tab === name ? "page" : undefined}
              className={cn(
                "rounded-t-md px-3 py-1.5 text-[11px] font-medium",
                tab === name
                  ? "border-b-2 border-[var(--content)] text-[var(--content)]"
                  : "text-[var(--content-muted)] hover:text-[var(--content)]",
              )}
            >
              {name}
              <span className="ml-1.5 font-mono text-[10px] text-[var(--content-faint)]">{countFor(name, data)}</span>
            </button>
          ))}
        </nav>

        {tab === "Overview" ? (
          <Panel>
            <PanelHeader>
              <PanelTitle>Overview</PanelTitle>
            </PanelHeader>
            <PanelBody>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Stat label="State" value={task.status} hint={task.approved ? "approved" : "not approved"} />
                <Stat label="Agent" value={task.assignedAgentName ?? "unassigned"} hint={task.assignedAgentId?.slice(0, 8)} />
                <Stat label="Cycle" value={`${task.currentCycle} / ${task.maxReviewCycles}`} />
                <Stat label="Duration" value={formatDuration(duration)} hint="start → completed" />
              </div>

              <dl className="mt-4 grid gap-x-6 gap-y-1 text-[11px] md:grid-cols-2">
                <Row label="Workspace">
                  <span className="font-mono break-all">{task.workspace}</span>
                </Row>
                <Row label="Stop reason">{task.stopReason ?? "(completed normally)"}</Row>
                <Row label="Created">{formatDateTime(task.createdAt)}</Row>
                <Row label="Updated">{formatRelative(task.updatedAt, now)}</Row>
                <Row label="Started">{task.startedAt ? formatDateTime(task.startedAt) : "—"}</Row>
                <Row label="Completed">{task.completedAt ? formatDateTime(task.completedAt) : "—"}</Row>
              </dl>

              <div className="mt-4">
                <h3 className="text-[10px] font-semibold tracking-[0.12em] text-[var(--content-faint)] uppercase">
                  Description
                </h3>
                <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--content-muted)]">
                  {task.description}
                </pre>
              </div>
            </PanelBody>
          </Panel>
        ) : null}

        {tab === "Timeline" ? (
          <Panel>
            <PanelHeader>
              <PanelTitle>Timeline</PanelTitle>
              <span className="text-[10px] text-[var(--content-faint)]">
                ordered by publish sequence
              </span>
            </PanelHeader>
            <PanelBody className="p-0">
              {data.activity.length === 0 ? (
                <EmptyState title="No events recorded" />
              ) : (
                <ol className="divide-y divide-[var(--border-subtle)]">
                  {data.activity.map((entry) => {
                    const described = describeEvent({
                      id: entry.eventId,
                      type: entry.eventType,
                      taskId: task.externalId,
                      timestamp: entry.occurredAt,
                      payload: entry.payload,
                      ...(entry.agentId ? { agentId: entry.agentId } : {}),
                    } as unknown as AnyTaskEvent);
                    return (
                      <li key={entry.eventId} className="flex items-start gap-3 px-3 py-2">
                        <span className="shrink-0 pt-0.5 font-mono text-[10px] text-[var(--content-faint)]">
                          {formatTime(entry.occurredAt)}
                        </span>
                        <span className="shrink-0 rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--content-muted)]">
                          {entry.eventType}
                        </span>
                        <span className="min-w-0 flex-1 text-[11px] text-[var(--content)]">
                          <span className="font-medium">{entry.agentName ?? described.actor}</span> {described.message}
                          {described.detail ? (
                            <span className="text-[var(--content-faint)]"> · {described.detail}</span>
                          ) : null}
                        </span>
                        {typeof entry.cycle === "number" ? (
                          <span className="shrink-0 font-mono text-[10px] text-[var(--content-faint)]">
                            c{entry.cycle}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              )}
            </PanelBody>
          </Panel>
        ) : null}

        {tab === "Runs" ? (
          <TablePanel title="Runs" empty={data.runs.length === 0 ? "No runs recorded" : undefined}>
            <thead>
              <tr>
                <Th>Run</Th>
                <Th>Status</Th>
                <Th>Agent</Th>
                <Th>Cycle</Th>
                <Th>Reason</Th>
                <Th>Duration</Th>
                <Th>Tokens</Th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <tr key={run.id}>
                  <Td><span className="font-mono text-[10px]">{run.runId}</span></Td>
                  <Td><Badge tone={run.status === "COMPLETED" ? "ok" : run.status === "FAILED" ? "danger" : "info"}>{run.status}</Badge></Td>
                  <Td>{run.agentName ?? "—"}</Td>
                  <Td>{run.cycle}</Td>
                  <Td>{run.reason ?? "—"}</Td>
                  <Td>{formatDuration(run.durationMs)}</Td>
                  <Td>{run.totalTokens || "—"}</Td>
                </tr>
              ))}
            </tbody>
          </TablePanel>
        ) : null}

        {tab === "Reviews" ? (
          <div className="space-y-3">
            {data.reviews.length === 0 ? (
              <Panel>
                <PanelBody>
                  <EmptyState title="No reviews yet" description="A review is stored for every judging cycle and never overwritten." />
                </PanelBody>
              </Panel>
            ) : (
              data.reviews.map((review) => <ReviewItem key={review.id} review={review} showTask={false} />)
            )}
          </div>
        ) : null}

        {tab === "Tools" ? (
          <TablePanel title="Tool calls" empty={data.toolCalls.length === 0 ? "No tool calls recorded" : undefined}>
            <thead>
              <tr>
                <Th>Tool</Th>
                <Th>Arguments (redacted)</Th>
                <Th>Result</Th>
                <Th>Exit</Th>
                <Th>Duration</Th>
                <Th>Output summary</Th>
              </tr>
            </thead>
            <tbody>
              {data.toolCalls.map((call) => (
                <tr key={call.id}>
                  <Td><span className="font-mono text-[10px] font-semibold">{call.tool}</span></Td>
                  <Td>
                    <code className="block max-w-[22rem] truncate font-mono text-[10px] text-[var(--content-muted)]" title={prettyJson(call.arguments)}>
                      {prettyJson(call.arguments)}
                    </code>
                  </Td>
                  <Td>
                    {call.success === undefined ? (
                      "—"
                    ) : (
                      <Badge tone={call.success ? "ok" : "danger"}>{call.success ? "ok" : "failed"}</Badge>
                    )}
                  </Td>
                  <Td>{call.exitCode ?? "—"}</Td>
                  <Td>{formatDuration(call.durationMs)}</Td>
                  <Td>
                    <span className="block max-w-[26rem] truncate text-[10px] text-[var(--content-muted)]" title={call.outputSummary}>
                      {call.outputSummary ?? "—"}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TablePanel>
        ) : null}

        {tab === "Files" ? (
          <TablePanel title="File changes" empty={data.files.length === 0 ? "No files changed" : undefined}>
            <thead>
              <tr>
                <Th>Path</Th>
                <Th>Change</Th>
                <Th>Summary</Th>
                <Th>Base hash</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {data.files.map((file) => (
                <tr key={file.id}>
                  <Td><span className="font-mono text-[10px]">{file.path}</span></Td>
                  <Td>
                    <Badge tone={file.changeType === "deleted" ? "danger" : file.changeType === "created" ? "ok" : "info"}>
                      {file.changeType}
                    </Badge>
                  </Td>
                  <Td>{file.summary ?? "—"}</Td>
                  <Td><span className="font-mono text-[10px]">{file.gitBaseHash?.slice(0, 8) ?? "—"}</span></Td>
                  <Td>{formatDateTime(file.occurredAt)}</Td>
                </tr>
              ))}
            </tbody>
          </TablePanel>
        ) : null}

        {tab === "Tests" ? (
          <TablePanel title="Test results" empty={data.tests.length === 0 ? "No test runs recorded" : undefined}>
            <thead>
              <tr>
                <Th>Key</Th>
                <Th>Command</Th>
                <Th>Exit</Th>
                <Th>Passed</Th>
                <Th>Duration</Th>
                <Th>Authoritative</Th>
              </tr>
            </thead>
            <tbody>
              {data.tests.map((test) => (
                <tr key={test.id} className={test.authoritative ? "bg-[var(--ok-soft)]" : undefined}>
                  <Td><span className="font-mono text-[10px]">{test.testKey}</span></Td>
                  <Td>
                    <span className="block max-w-[28rem] truncate font-mono text-[10px]" title={test.command}>
                      {test.command}
                    </span>
                  </Td>
                  <Td>{test.exitCode ?? "—"}</Td>
                  <Td>
                    <Badge tone={test.passed ? "ok" : "danger"}>{test.passed ? "passed" : "failed"}</Badge>
                  </Td>
                  <Td>{formatDuration(test.durationMs)}</Td>
                  <Td>{test.authoritative ? <Badge tone="ok">final</Badge> : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </TablePanel>
        ) : null}
      </div>
    </PageShell>
  );
}

function countFor(tab: Tab, data: TaskDetailView): React.ReactNode {
  switch (tab) {
    case "Timeline":
      return data.activity.length;
    case "Runs":
      return data.runs.length;
    case "Reviews":
      return data.reviews.length;
    case "Tools":
      return data.toolCalls.length;
    case "Files":
      return data.files.length;
    case "Tests":
      return data.tests.length;
    default:
      return null;
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-[var(--content-faint)]">{label}</dt>
      <dd className="min-w-0 text-[var(--content)]">{children}</dd>
    </div>
  );
}

function TablePanel({
  title,
  empty,
  children,
}: {
  title: string;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{title}</PanelTitle>
      </PanelHeader>
      <PanelBody className="p-0">
        {empty ? (
          <EmptyState title={empty} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">{children}</table>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

function PageShell({
  id,
  status,
  children,
}: {
  id: string;
  status?: string;
  children: React.ReactNode;
}) {
  void id;
  void status;
  return <div className="min-h-0">{children}</div>;
}

export { severityTone };
