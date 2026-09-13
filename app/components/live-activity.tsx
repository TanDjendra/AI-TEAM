"use client";

/**
 * Live activity feed.
 *
 * Renders realtime events as they arrive over SSE, and falls back to the
 * historical rows from GET /api/activity when the stream is down or empty. The
 * database is the source of truth; the stream is the fast path.
 */

import * as React from "react";
import Link from "next/link";

import { Badge, Panel, PanelBody, PanelHeader, PanelTitle } from "./ui.js";
import { cn, formatTime } from "../lib/utils.js";
import { eventTone } from "../lib/status.js";
import { agentLabel, describeEvent } from "../lib/event-text.js";
import type { AnyTaskEvent } from "../../src/events/types.js";
import type { ActivityView } from "../../src/dashboard/service.js";
import type { RealtimeEntry } from "../lib/use-event-stream.js";

export interface LiveActivityProps {
  realtime: RealtimeEntry[];
  historical: ActivityView[];
  connected: boolean;
  className?: string;
  limit?: number;
}

/** One row, from either source, in a single shape. */
interface FeedRow {
  key: string;
  timestamp: string;
  eventType: string;
  actor: string;
  taskId?: string;
  message: string;
  detail?: string;
  live: boolean;
}

function fromRealtime(entry: RealtimeEntry): FeedRow {
  const description = describeEvent(entry.event);
  return {
    key: entry.key,
    timestamp: entry.event.timestamp,
    eventType: entry.event.type,
    actor: description.actor,
    taskId: entry.event.taskId,
    message: description.message,
    ...(description.detail ? { detail: description.detail } : {}),
    live: true,
  };
}

function fromHistorical(view: ActivityView): FeedRow {
  const description = describeEvent({
    id: view.eventId,
    type: view.eventType,
    taskId: view.taskExternalId ?? view.taskId ?? "",
    timestamp: view.occurredAt,
    payload: view.payload,
    ...(view.agentId ? { agentId: view.agentId } : {}),
  } as unknown as AnyTaskEvent);

  return {
    key: view.eventId,
    timestamp: view.occurredAt,
    eventType: view.eventType,
    actor: view.agentName ?? description.actor,
    ...(view.taskExternalId ? { taskId: view.taskExternalId } : {}),
    message: description.message,
    ...(description.detail ? { detail: description.detail } : {}),
    live: false,
  };
}

export function LiveActivity({ realtime, historical, connected, className, limit = 60 }: LiveActivityProps) {
  // Live events win: they are the same records, arriving sooner. Historical rows
  // whose id is already in the live list are dropped to avoid double display.
  const rows = React.useMemo(() => {
    const liveIds = new Set(realtime.map((entry) => entry.key));
    const live = realtime.map(fromRealtime);
    const history = historical.filter((view) => !liveIds.has(view.eventId)).map(fromHistorical);
    const merged = [...live, ...history].slice(0, limit);
    return merged.sort((a, b) => {
      const left = Date.parse(a.timestamp);
      const right = Date.parse(b.timestamp);
      if (Number.isNaN(left) || Number.isNaN(right)) return 0;
      return right - left;
    });
  }, [realtime, historical, limit]);

  return (
    <Panel className={cn("flex min-h-0 flex-col", className)}>
      <PanelHeader>
        <PanelTitle>Live activity</PanelTitle>
        <div className="flex items-center gap-2">
          {rows.some((row) => row.live) ? <Badge tone="ok" dot>live</Badge> : null}
          <span className="text-[10px] text-[var(--content-faint)]">
            {connected ? "streaming" : "historical only"} · {rows.length}
          </span>
        </div>
      </PanelHeader>

      <PanelBody className="min-h-0 flex-1 overflow-y-auto p-0">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-[11px] text-[var(--content-faint)]">
            No activity recorded yet. Events appear here as agents work.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {rows.map((row) => (
              <li key={row.key} className="flex items-start gap-2 px-3 py-1.5">
                <span className="shrink-0 pt-0.5 font-mono text-[10px] text-[var(--content-faint)]">
                  {formatTime(row.timestamp)}
                </span>
                <Badge tone={eventTone(row.eventType)} className="shrink-0">
                  {row.actor}
                </Badge>
                <span className="min-w-0 flex-1 text-[11px] leading-snug text-[var(--content)]">
                  {row.message}
                  {row.detail ? (
                    <span className="text-[var(--content-faint)]"> · {row.detail}</span>
                  ) : null}
                </span>
                {row.taskId ? (
                  <Link
                    href={`/tasks/${encodeURIComponent(row.taskId)}`}
                    className="shrink-0 font-mono text-[10px] text-[var(--content-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--content)]"
                  >
                    {row.taskId}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PanelBody>
    </Panel>
  );
}

export { agentLabel };
