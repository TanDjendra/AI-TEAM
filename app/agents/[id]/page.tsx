"use client";

/**
 * Agent detail page.
 *
 * Only metrics the database can actually support are shown: status, current
 * task, task counters derived from stored rows, recent activity and recent tool
 * calls. No invented success rates or progress figures.
 */

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { Badge, EmptyState, ErrorState, Panel, PanelBody, PanelHeader, PanelTitle, Stat, Td, Th } from "../../components/ui.js";
import { cn, formatDateTime, formatDuration, formatRelative, formatTime } from "../../lib/utils.js";
import { agentTone, severityTone } from "../../lib/status.js";
import { useApi } from "../../lib/use-api.js";
import type { ActivityView, AgentView, ReviewView, ToolCallView } from "../../../src/dashboard/service.js";

interface AgentDetail {
  agent: AgentView;
  recentActivity: ActivityView[];
  recentToolCalls: ToolCallView[];
  recentReviews: ReviewView[];
  stats: Record<string, number>;
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const { data, error, loading } = useApi<AgentDetail>(
    id ? `/api/agents/${encodeURIComponent(id)}` : "/api/agents/__missing__",
  );

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  if (loading && !data) {
    return <p className="p-6 text-[11px] text-[var(--content-faint)]">Loading agent…</p>;
  }

  if (error) {
    return (
      <div className="p-6">
        <ErrorState message={`Could not load agent ${id}.`} detail={error} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6">
        <EmptyState title="Agent not found" description={`No agent with id or key ${id}.`} />
      </div>
    );
  }

  const { agent, recentActivity, recentToolCalls, recentReviews, stats } = data;
  const isReviewer = agent.role === "reviewer";

  return (
    <div className="space-y-3 p-3 lg:p-4">
      <Panel>
        <PanelHeader>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <PanelTitle>{agent.role === "reviewer" ? "GPT Luna" : "DeepSeek"}</PanelTitle>
              <Badge tone={agentTone(agent.status)} dot>
                {agent.status}
              </Badge>
              <Badge tone={isReviewer ? "reviewer" : "coder"}>{agent.role.toUpperCase()}</Badge>
            </div>
            <p className="mt-1 font-mono text-[11px] text-[var(--content-muted)]">{agent.model}</p>
          </div>
          <Link href="/" className="shrink-0 text-[11px] text-[var(--content-muted)] underline decoration-dotted underline-offset-2">
            ← Command Center
          </Link>
        </PanelHeader>

        <PanelBody>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Provider" value={agent.provider} />
            <Stat label="Last seen" value={formatRelative(agent.lastSeen, now)} hint={formatDateTime(agent.lastSeen)} />
            <Stat
              label="Current task"
              value={agent.currentTaskExternalId ?? "—"}
              {...(agent.currentTaskTitle ? { hint: agent.currentTaskTitle } : {})}
            />
            <Stat label="Current cycle" value={agent.currentCycle ?? "—"} />
          </div>
        </PanelBody>
      </Panel>

      {/* Counters: exactly the rows the database holds. */}
      <Panel>
        <PanelHeader>
          <PanelTitle>{isReviewer ? "Review counters" : "Task counters"}</PanelTitle>
          <span className="text-[10px] text-[var(--content-faint)]">derived from stored rows only</span>
        </PanelHeader>
        <PanelBody>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {Object.entries(stats).map(([label, value]) => (
              <Stat key={label} label={label} value={value} />
            ))}
            {Object.keys(stats).length === 0 ? (
              <p className="text-[11px] text-[var(--content-faint)]">No counters available.</p>
            ) : null}
          </div>
        </PanelBody>
      </Panel>

      {isReviewer && recentReviews.length > 0 ? (
        <Panel>
          <PanelHeader>
            <PanelTitle>Recent reviews</PanelTitle>
          </PanelHeader>
          <PanelBody className="p-0">
            <ul className="divide-y divide-[var(--border-subtle)]">
              {recentReviews.map((review) => (
                <li key={review.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11px]">
                  <Badge tone={review.verdict.toUpperCase() === "APPROVED" ? "ok" : "danger"}>
                    {review.verdict}
                  </Badge>
                  <Badge tone={severityTone(review.severity)}>{review.severity}</Badge>
                  <span className="font-mono text-[10px] text-[var(--content-faint)]">cycle {review.cycle}</span>
                  {review.taskExternalId ? (
                    <Link
                      href={`/tasks/${encodeURIComponent(review.taskExternalId)}`}
                      className="font-mono text-[10px] underline decoration-dotted underline-offset-2"
                    >
                      {review.taskExternalId}
                    </Link>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-[var(--content-muted)]">{review.summary}</span>
                  <span className="text-[10px] text-[var(--content-faint)]">{formatDateTime(review.createdAt)}</span>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>
      ) : null}

      {recentToolCalls.length > 0 ? (
        <Panel>
          <PanelHeader>
            <PanelTitle>Recent tool calls</PanelTitle>
          </PanelHeader>
          <PanelBody className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>Tool</Th>
                    <Th>Started</Th>
                    <Th>Duration</Th>
                    <Th>Result</Th>
                    <Th>Output summary</Th>
                  </tr>
                </thead>
                <tbody>
                  {recentToolCalls.map((call) => (
                    <tr key={call.id}>
                      <Td><span className="font-mono text-[10px]">{call.tool}</span></Td>
                      <Td>{formatTime(call.startedAt)}</Td>
                      <Td>{formatDuration(call.durationMs)}</Td>
                      <Td>
                        {call.success === undefined ? "—" : <Badge tone={call.success ? "ok" : "danger"}>{call.success ? "ok" : "failed"}</Badge>}
                      </Td>
                      <Td>
                        <span className="block max-w-[26rem] truncate text-[10px] text-[var(--content-muted)]" title={call.outputSummary}>
                          {call.outputSummary ?? "—"}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader>
          <PanelTitle>Recent activity</PanelTitle>
          <span className="text-[10px] text-[var(--content-faint)]">{recentActivity.length} event(s)</span>
        </PanelHeader>
        <PanelBody className={cn("p-0", recentActivity.length > 0 && "max-h-[360px] overflow-y-auto")}>
          {recentActivity.length === 0 ? (
            <EmptyState title="No activity recorded for this agent" />
          ) : (
            <ul className="divide-y divide-[var(--border-subtle)]">
              {recentActivity.map((entry) => (
                <li key={entry.eventId} className="flex items-start gap-2 px-3 py-1.5">
                  <span className="shrink-0 font-mono text-[10px] text-[var(--content-faint)]">{formatTime(entry.occurredAt)}</span>
                  <span className="shrink-0 rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--content-muted)]">
                    {entry.eventType}
                  </span>
                  <span className="min-w-0 flex-1 text-[11px] text-[var(--content)]">{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
