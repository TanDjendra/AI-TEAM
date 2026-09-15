"use client";

/**
 * Diagnostics panel (Phase V2.1).
 *
 * Read-only facts an operator needs to trust the Settings page:
 *   - where the config file is, and whether it exists;
 *   - its content hash, so an external edit is detectable;
 *   - where each effective model came from (config file vs .env);
 *   - the honest restart caveat for separate worker processes.
 *
 * Nothing here is inferred or guessed: every value comes from the server view.
 */

import * as React from "react";

import { Badge, KeyValue, Mono, Panel, PanelBody, PanelHeader, PanelTitle, Stat } from "../ui.js";
import type { ConfigViewModel } from "../../lib/use-config.js";

function formatTime(ms?: number): string {
  if (ms === undefined) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").replace("Z", " UTC");
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function DiagnosticsPanel({ view }: { view: ConfigViewModel }) {
  const file = view.file;

  return (
    <div className="space-y-3">
      <Panel>
        <PanelHeader>
          <PanelTitle>Configuration file</PanelTitle>
          <Badge tone={file.exists ? "ok" : "warn"} dot>
            {file.exists ? "exists" : "not created yet"}
          </Badge>
        </PanelHeader>
        <PanelBody>
          <dl className="divide-y divide-[var(--border-subtle)]">
            <KeyValue label="Path">
              <Mono className="break-all">{view.path}</Mono>
            </KeyValue>
            <KeyValue label="Modified">
              <Mono>{formatTime(file.mtimeMs)}</Mono>
            </KeyValue>
            <KeyValue label="Size">
              <Mono>{formatBytes(file.sizeBytes)}</Mono>
            </KeyValue>
            <KeyValue label="Hash">
              <Mono>{file.hash ?? "—"}</Mono>
            </KeyValue>
          </dl>
          {!file.exists ? (
            <p className="mt-2 text-[11px] text-[var(--content-muted)]">
              No file exists yet. Saving any change creates it (atomically), and the orchestrator keeps using the values
              from the environment until then.
            </p>
          ) : null}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Effective models &amp; provenance</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Stat
              label="Coder"
              value={<Mono>{view.models.coder || "—"}</Mono>}
              hint={view.sources.coder === "config" ? "from config file" : "from .env"}
            />
            <Stat
              label="Reviewer"
              value={<Mono>{view.models.reviewer || "—"}</Mono>}
              hint={view.sources.reviewer === "config" ? "from config file" : "from .env"}
            />
            <Stat
              label="Planner"
              value={<Mono>{view.models.planner || "—"}</Mono>}
              hint={view.sources.planner === "config" ? "from config file" : "from .env"}
            />
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Reload behaviour</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <p className="text-[11px] leading-relaxed text-[var(--content-muted)]">
            Saving reloads the configuration in memory for <strong>this process</strong> — the next task runs with the
            new models without a server restart. A separately launched worker (for example <Mono>npm run worker</Mono>)
            reads the file at its own startup and must be restarted to pick up a change. In-flight runs keep the profile
            they started with, which is what makes the audit trail truthful.
          </p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Secrets</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <p className="text-[11px] leading-relaxed text-[var(--content-muted)]">
            <Mono>ROUTER_API_KEY</Mono> and <Mono>DATABASE_URL</Mono> are never written to this file and never returned
            to the browser. The environment always wins for secrets; the JSON file wins only for models and roles.
          </p>
        </PanelBody>
      </Panel>
    </div>
  );
}
