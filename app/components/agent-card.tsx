"use client";

/**
 * Agent card — one per configured agent, rendered from GET /api/agents.
 *
 * Every value shown is a stored column. There is no progress bar and no
 * percentage because the database has no such measure; "elapsed" is arithmetic
 * on a real start timestamp.
 */

import * as React from "react";
import Link from "next/link";
import { Bot, ShieldCheck } from "lucide-react";

import { Badge, Panel, PanelBody } from "./ui.js";
import { cn, formatElapsedFrom, formatRelative } from "../lib/utils.js";
import { agentTone } from "../lib/status.js";
import type { AgentView } from "../../src/dashboard/service.js";

/**
 * Card heading.
 *
 * The card spec names the agents in caps ("DEEPSEEK", "GPT LUNA"), while the
 * activity feed reads as prose ("DeepSeek called list_files" — see event-text).
 * The coder name comes from the API's model-derived `displayName`; nothing is
 * hardcoded per model.
 */
function agentDisplayName(agent: AgentView): string {
  return agent.role === "reviewer" ? "GPT LUNA" : agent.displayName;
}

export function AgentCard({ agent, now }: { agent: AgentView; now: number }) {
  const tone = agentTone(agent.status);
  const active = agent.status === "WORKING" || agent.status === "REVIEWING";
  const Icon = agent.role === "reviewer" ? ShieldCheck : Bot;

  return (
    <Panel className={cn("overflow-hidden", active && "border-[var(--border-strong)]")}>
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5",
          agent.role === "reviewer" ? "bg-[var(--reviewer-soft)]" : "bg-[var(--coder-soft)]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            className={cn("size-4 shrink-0", agent.role === "reviewer" ? "text-[var(--reviewer)]" : "text-[var(--coder)]")}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-[var(--content)]">{agentDisplayName(agent)}</div>
            <div className="truncate text-[10px] font-medium tracking-[0.12em] text-[var(--content-faint)] uppercase">
              {agent.role === "reviewer" ? "REVIEWER" : "CODER"}
            </div>
          </div>
        </div>
        <Badge tone={tone} dot>
          {agent.status}
        </Badge>
      </div>

      <PanelBody className="space-y-2">
        <div className="truncate font-mono text-[11px] text-[var(--content-muted)]" title={agent.model}>
          {agent.model}
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          <dt className="text-[var(--content-faint)]">Task</dt>
          <dd className="min-w-0 truncate">
            {agent.currentTaskExternalId ? (
              <Link
                href={`/tasks/${encodeURIComponent(agent.currentTaskExternalId)}`}
                className="text-[var(--content)] underline decoration-dotted underline-offset-2"
                title={agent.currentTaskTitle}
              >
                {agent.currentTaskExternalId}
              </Link>
            ) : (
              <span className="text-[var(--content-faint)]">—</span>
            )}
          </dd>

          <dt className="text-[var(--content-faint)]">Cycle</dt>
          <dd className="text-[var(--content)]">
            {agent.currentCycle === undefined ? <span className="text-[var(--content-faint)]">—</span> : agent.currentCycle}
          </dd>

          <dt className="text-[var(--content-faint)]">Elapsed</dt>
          <dd className="text-[var(--content)]">
            {active && agent.currentTaskId ? (
              // Recomputed on each render tick; still pure arithmetic.
              formatElapsedFrom(agent.lastSeen, now) === "—" ? "—" : elapsedLabel(agent)
            ) : (
              <span className="text-[var(--content-faint)]">—</span>
            )}
          </dd>

          <dt className="text-[var(--content-faint)]">Last seen</dt>
          <dd className="text-[var(--content-muted)]">{formatRelative(agent.lastSeen, now)}</dd>

          <dt className="text-[var(--content-faint)]">Activity</dt>
          <dd className="min-w-0 truncate text-[var(--content-muted)]" title={agent.lastActivitySummary}>
            {agent.lastActivityType ? (
              <>
                <span className="font-mono text-[10px] text-[var(--content-faint)]">{agent.lastActivityType}</span>
                {agent.lastActivitySummary ? <span> · {agent.lastActivitySummary}</span> : null}
              </>
            ) : (
              <span className="text-[var(--content-faint)]">no activity recorded</span>
            )}
          </dd>
        </dl>

        <Link
          href={`/agents/${encodeURIComponent(agent.agentKey)}`}
          className="inline-block text-[11px] text-[var(--content-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--content)]"
        >
          Open agent detail
        </Link>
      </PanelBody>
    </Panel>
  );
}

function elapsedLabel(agent: AgentView): string {
  if (agent.elapsedSeconds === undefined) return "—";
  const seconds = agent.elapsedSeconds;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
