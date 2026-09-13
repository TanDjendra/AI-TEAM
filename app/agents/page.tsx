"use client";

/** Agents index: the same cards the Command Center shows, plus a table view. */

import * as React from "react";

import { AgentCard } from "../components/agent-card.js";
import { EmptyState, ErrorState, Panel, PanelBody, PanelHeader, PanelTitle, SkeletonRows } from "../components/ui.js";
import { useApi } from "../lib/use-api.js";
import type { AgentView, SystemStatusView } from "../../src/dashboard/service.js";

export default function AgentsPage() {
  const { data, error, loading } = useApi<SystemStatusView>("/api/status");
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const agents: AgentView[] = data?.agents ?? [];

  return (
    <div className="space-y-3 p-3 lg:p-4">
      <Panel>
        <PanelHeader>
          <PanelTitle>Agents</PanelTitle>
          <span className="text-[10px] text-[var(--content-faint)]">{agents.length} registered</span>
        </PanelHeader>
        <PanelBody>
          {loading && !data ? (
            <SkeletonRows rows={4} />
          ) : error ? (
            <ErrorState message="Could not load agents." detail={error} />
          ) : agents.length === 0 ? (
            <EmptyState
              title="No agents registered"
              description="Agents are created on the first orchestrator run; run a task to register them."
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {agents.map((agent) => (
                <AgentCard key={agent.id} agent={agent} now={now} />
              ))}
            </div>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
