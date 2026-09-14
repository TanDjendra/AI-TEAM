"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { Badge, EmptyState, ErrorState, Panel, PanelBody, PanelHeader, PanelTitle, Stat } from "../../components/ui.js";
import { DagVisualizer } from "../../components/dag-visualizer.js";
import { cn, formatDateTime, formatRelative } from "../../lib/utils.js";
import { workflowTone } from "../../components/workflow-board.js";
import { useApi } from "../../lib/use-api.js";
import type { WorkflowView, WorkflowNodeView } from "../../../src/dashboard/service.js";

function PageShell({ id, status, children }: { id: string; status?: string; children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col bg-[var(--background)]">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface)] px-3 lg:px-4">
        <div className="flex items-center gap-2 min-w-0">
          <Link
            href="/"
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-[var(--content-muted)] transition-colors hover:bg-[var(--surface-raised)] hover:text-[var(--content)]"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="size-3.5 opacity-70">
              <path fillRule="evenodd" d="M10.78 3.22a.75.75 0 0 1 0 1.06L7.56 7.5l3.22 3.22a.75.75 0 1 1-1.06 1.06l-3.75-3.75a.75.75 0 0 1 0-1.06l3.75-3.75a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
            </svg>
            Dashboard
          </Link>
          <span className="text-[var(--border-strong)]">/</span>
          <h1 className="truncate font-mono text-[11px] font-semibold text-[var(--content)]">
            Workflow {id}
          </h1>
          {status && (
            <Badge tone={workflowTone(status)} dot className="ml-2">
              {status}
            </Badge>
          )}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

export default function WorkflowDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const { data, error, loading } = useApi<{ workflow: WorkflowView; nodes: WorkflowNodeView[]; artifacts: any[] }>(
    id ? `/api/workflows/${encodeURIComponent(id)}` : "/api/workflows/__missing__",
  );

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  if (loading && !data) {
    return <PageShell id={id}><p className="p-6 text-[11px] text-[var(--content-faint)]">Loading workflow…</p></PageShell>;
  }

  if (error) {
    return (
      <PageShell id={id}>
        <div className="p-6">
          <ErrorState message={`Could not load workflow ${id}.`} detail={error} />
        </div>
      </PageShell>
    );
  }

  if (!data || !data.workflow) {
    return (
      <PageShell id={id}>
        <div className="p-6">
          <EmptyState title="Workflow not found" description={`No workflow with id ${id}.`} />
        </div>
      </PageShell>
    );
  }

  const { workflow, nodes, artifacts } = data;

  return (
    <PageShell id={id} status={workflow.status}>
      <div className="space-y-4 p-3 lg:p-4">
        <Panel>
          <PanelHeader>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <PanelTitle>{workflow.id}</PanelTitle>
                <Badge tone={workflowTone(workflow.status)} dot>
                  {workflow.status}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-[var(--content-muted)]">
                Auto-generated Workflow Plan
              </p>
            </div>
          </PanelHeader>

          <PanelBody className="border-t border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-0">
            <div className="grid divide-y divide-[var(--border-subtle)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <Stat label="Total Nodes" value={nodes.length.toString()} />
              <Stat label="Total Artifacts" value={artifacts.length.toString()} />
              <Stat label="Created" value={formatRelative(workflow.createdAt, now)} hint={formatDateTime(workflow.createdAt)} />
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>DAG Visualization</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <DagVisualizer workflow={workflow} nodes={nodes} />
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Nodes Details</PanelTitle>
          </PanelHeader>
          <PanelBody className="p-0 overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-[var(--surface-sunken)] text-[var(--content-faint)] uppercase tracking-wider text-[10px] font-semibold border-b border-[var(--border-subtle)]">
                <tr>
                  <th className="p-2.5 font-medium">Node Key</th>
                  <th className="p-2.5 font-medium">Status</th>
                  <th className="p-2.5 font-medium">Goal</th>
                  <th className="p-2.5 font-medium">Assigned Task</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {nodes.map(node => (
                  <tr key={node.nodeKey} className="transition-colors hover:bg-[var(--surface-raised)]">
                    <td className="p-2.5 font-mono text-[var(--content)]">{node.nodeKey}</td>
                    <td className="p-2.5">
                      <Badge tone={workflowTone(node.status)}>{node.status}</Badge>
                    </td>
                    <td className="p-2.5 text-[var(--content-muted)] max-w-sm truncate" title={workflow.spec.nodes.find(n => n.key === node.nodeKey)?.description}>
                      {workflow.spec.nodes.find(n => n.key === node.nodeKey)?.description}
                    </td>
                    <td className="p-2.5 font-mono text-[var(--content-muted)]">
                      {node.currentTaskId ? (
                        <Link href={`/tasks/${node.currentTaskId}`} className="hover:underline text-[var(--primary)]">
                          {node.currentTaskId.split('-').pop()}
                        </Link>
                      ) : (
                        <span className="opacity-50">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </PanelBody>
        </Panel>
      </div>
    </PageShell>
  );
}
