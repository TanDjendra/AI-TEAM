"use client";

/**
 * Settings — read-only, and deliberately so.
 *
 * The dashboard must not accept credentials from the browser (an API key typed
 * into a web form is a secret leaked into a JS heap and a browser cache), so
 * everything that is secret is shown as a presence flag only. Configuration is
 * changed in `.env`, which is where the orchestrator reads it.
 */

import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, Stat } from "../components/ui.js";
import { useApi } from "../lib/use-api.js";
import type { SystemStatusView } from "../../src/dashboard/service.js";

export default function SettingsPage() {
  const { data, error } = useApi<SystemStatusView>("/api/status");

  return (
    <div className="space-y-3 p-3 lg:p-4">
      <Panel>
        <PanelHeader>
          <PanelTitle>Settings</PanelTitle>
          <span className="text-[10px] text-[var(--content-faint)]">read-only · secrets are never sent to the browser</span>
        </PanelHeader>
        <PanelBody>
          <p className="text-[11px] leading-relaxed text-[var(--content-muted)]">
            Model and router configuration is read from the server environment (<code className="font-mono">.env</code>).
            The dashboard will not accept an API key through a form, because anything typed here would live in the
            browser. Update <code className="font-mono">ROUTER_API_KEY</code> and the model variables on the server and
            restart the dashboard.
          </p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Router</PanelTitle>
          {error ? <Badge tone="danger">unavailable</Badge> : <Badge tone={data ? "ok" : "neutral"} dot>{data ? "configured" : "loading"}</Badge>}
        </PanelHeader>
        <PanelBody>
          {data ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Stat label="Base URL" value={data.router.baseUrl} />
              <Stat label="Coder model" value={data.router.coderModel} />
              <Stat label="Reviewer model" value={data.router.reviewerModel} />
            </div>
          ) : (
            <p className="text-[11px] text-[var(--content-faint)]">Loading…</p>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Database</PanelTitle>
        </PanelHeader>
        <PanelBody>
          {data ? (
            <>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Stat label="Configured" value={<Badge tone={data.database.configured ? "ok" : "danger"}>{String(data.database.configured)}</Badge>} />
                <Stat label="Ready" value={<Badge tone={data.database.ready ? "ok" : "danger"}>{String(data.database.ready)}</Badge>} />
                <Stat label="Tasks" value={data.counts.tasks} />
                <Stat label="Events" value={data.counts.activity} />
              </div>
              {data.database.warnings.length > 0 ? (
                <ul className="mt-3 list-disc space-y-0.5 pl-4 text-[11px] text-[var(--warn)]">
                  {data.database.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="text-[11px] text-[var(--content-faint)]">Loading…</p>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Secrets</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <p className="text-[11px] text-[var(--content-muted)]">
            <code className="font-mono">ROUTER_API_KEY</code> is held server-side only. It is redacted from every event,
            activity payload, tool argument and log line before storage, and it is never included in any API response.
          </p>
        </PanelBody>
      </Panel>
    </div>
  );
}
