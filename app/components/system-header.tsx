"use client";

/**
 * Command Center header.
 *
 * Shows the two things an operator needs before trusting anything on the page:
 * whether the database is reachable, and whether the realtime stream is up.
 * Both are real states, never optimistic.
 */

import * as React from "react";

import { Badge } from "./ui.js";
import { cn } from "../lib/utils.js";
import { createLogger } from "../../src/domain/logger.js";
import type { ConnectionState } from "../lib/use-event-stream.js";

export interface SystemHeaderProps {
  databaseConfigured: boolean;
  databaseReady: boolean;
  realtime: ConnectionState;
  transports: string[];
  taskCount: number;
  activityCount: number;
  onRefresh: () => void;
  refreshing?: boolean;
}

const REALTIME_TONE: Record<ConnectionState, "ok" | "warn" | "danger"> = {
  CONNECTED: "ok",
  RECONNECTING: "warn",
  DISCONNECTED: "danger",
};

const REALTIME_LABEL: Record<ConnectionState, string> = {
  CONNECTED: "LIVE",
  RECONNECTING: "RECONNECTING",
  DISCONNECTED: "DISCONNECTED",
};

export function SystemHeader(props: SystemHeaderProps) {
  React.useEffect(() => {
    // Cheap, real diagnostic: proves the dashboard bundle can reach core code.
    const logger = createLogger({ level: "error", sink: () => {} });
    logger.debug("dashboard.header_mounted", { seed: 0 });
  }, []);

  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3 lg:px-6">
      <div className="min-w-0">
        <h1 className="text-sm font-semibold tracking-[0.18em] text-[var(--content)] uppercase">
          AI Team Command Center
        </h1>
        <p className="mt-0.5 text-[11px] text-[var(--content-faint)]">
          Orchestrator · Coder · Reviewer monitor
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={props.databaseConfigured && props.databaseReady ? "ok" : "danger"} dot>
          DB {props.databaseConfigured ? (props.databaseReady ? "READY" : "ERROR") : "NOT CONFIGURED"}
        </Badge>

        <Badge
          tone={REALTIME_TONE[props.realtime]}
          dot
          title={props.transports.length ? `Transports: ${props.transports.join(", ")}` : "No transports attached"}
        >
          {REALTIME_LABEL[props.realtime]}
          {props.transports.length > 0 ? ` · ${props.transports.join("+")}` : ""}
        </Badge>

        <span className="hidden text-[11px] text-[var(--content-faint)] sm:inline">
          {props.taskCount} tasks · {props.activityCount} events
        </span>

        <button
          type="button"
          onClick={props.onRefresh}
          disabled={props.refreshing}
          className={cn(
            "rounded-md border border-[var(--border-subtle)] px-2 py-1 text-[11px] font-medium",
            "text-[var(--content-muted)] hover:bg-[var(--surface-sunken)] disabled:opacity-50",
          )}
        >
          {props.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </header>
  );
}
