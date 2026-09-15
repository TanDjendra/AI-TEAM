"use client";

/**
 * Settings — Dynamic configuration (Phase V2.1).
 *
 * Replaces the old read-only page. The owner can now change the models used by
 * the Coder / Reviewer / Planner profiles and define custom agent roles, without
 * editing `.env` or source files.
 *
 * Safety model, restated where an operator will read it:
 *   - every save is validated against the Zod schema before the file is written;
 *   - the write is atomic, so a crash or a rejected save cannot corrupt config;
 *   - secrets stay in the environment and are never sent to the browser;
 *   - saving reloads config in memory for this process (no restart needed) but
 *     separate workers must be restarted.
 */

import * as React from "react";

import {
  Badge,
  Button,
  ErrorState,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui.js";
import { useConfig } from "../lib/use-config.js";
import { ModelsTab } from "../components/settings/models-tab.js";
import { RolesTab } from "../components/settings/roles-tab.js";
import { RawConfigTab } from "../components/settings/raw-config-tab.js";
import { DiagnosticsPanel } from "../components/settings/diagnostics-panel.js";

export default function SettingsPage() {
  const { data, error, loading, refresh } = useConfig();

  return (
    <div className="space-y-3 p-3 lg:p-4">
      <Panel>
        <PanelHeader>
          <PanelTitle>Settings</PanelTitle>
          <div className="flex items-center gap-2">
            {data ? (
              <Badge tone={data.file.exists ? "ok" : "neutral"} dot>
                {data.file.exists ? "config file" : "no file yet"}
              </Badge>
            ) : null}
            <Button variant="outline" onClick={refresh} disabled={loading}>
              {loading ? "Loading…" : "Reload"}
            </Button>
          </div>
        </PanelHeader>
        <PanelBody>
          <p className="text-[11px] leading-relaxed text-[var(--content-muted)]">
            Models and roles are stored in a validated JSON file and win over <code className="font-mono">.env</code>{" "}
            for models and roles. Secrets (<code className="font-mono">ROUTER_API_KEY</code>,{" "}
            <code className="font-mono">DATABASE_URL</code>) stay in the environment and are never sent here. Every
            change is validated before it is written.
          </p>
        </PanelBody>
      </Panel>

      {loading && !data ? (
        <SkeletonRows rows={5} />
      ) : error ? (
        <ErrorState message="Could not load the configuration." detail={error} />
      ) : data ? (
        <Tabs defaultValue="models">
          <TabsList>
            <TabsTrigger value="models">Models</TabsTrigger>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            <TabsTrigger value="raw">Raw config</TabsTrigger>
            <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
          </TabsList>

          <TabsContent value="models">
            <ModelsTab view={data} onSaved={refresh} />
          </TabsContent>

          <TabsContent value="roles">
            <RolesTab view={data} onSaved={refresh} />
          </TabsContent>

          <TabsContent value="raw">
            <RawConfigTab view={data} onSaved={refresh} />
          </TabsContent>

          <TabsContent value="diagnostics">
            <DiagnosticsPanel view={data} />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}
