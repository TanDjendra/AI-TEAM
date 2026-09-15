"use client";

/**
 * Command Center — the main dashboard.
 *
 * Reads exclusively from the REST API (which reads the database) and the SSE
 * event stream. Realtime events trigger a debounced refetch so cards and the
 * board reconcile with the database; the stream itself never invents state.
 */

import * as React from "react";

import { AgentCard } from "./components/agent-card.js";
import { CreateTaskForm } from "./components/create-task-form.js";
import { LiveActivity } from "./components/live-activity.js";
import { RecoveryBanner } from "./components/recovery-banner.js";
import { ReviewCenter } from "./components/review-center.js";
import { SystemHeader } from "./components/system-header.js";
import { TaskBoard } from "./components/task-board.js";
import { WorkflowBoard } from "./components/workflow-board.js";
import { IntegrationBoard } from "./components/integration-board.js";
import { ErrorState, Panel, PanelBody, PanelHeader, PanelTitle, SkeletonRows, Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui.js";
import { useApi } from "./lib/use-api.js";
import { useEventStream } from "./lib/use-event-stream.js";
import type {
  ActivityView,
  AgentView,
  ReviewView,
  SystemStatusView,
  TaskView,
  WorkflowView,
  IntegrationCandidateView,
} from "../src/dashboard/service.js";

export default function CommandCenterPage() {
  const status = useApi<SystemStatusView>("/api/status");
  const tasks = useApi<TaskView[]>("/api/tasks");
  const workflows = useApi<WorkflowView[]>("/api/workflows");
  const integrations = useApi<IntegrationCandidateView[]>("/api/integrations");
  const reviews = useApi<ReviewView[]>("/api/reviews?limit=50");
  const activity = useApi<ActivityView[]>("/api/activity?limit=100");

  const stream = useEventStream({ limit: 200 });

  // A clock for relative times. Ticking once a second would re-render the whole
  // tree for no reason, so it moves every 5s — relative labels are coarse.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  // Reconcile with the database shortly after a realtime event lands. A short
  // debounce collapses the burst of events one tool call produces.
  const latestEventId = stream.entries[0]?.key;
  const refreshAll = React.useCallback(() => {
    status.refresh();
    tasks.refresh();
    workflows.refresh();
    integrations.refresh();
    reviews.refresh();
    activity.refresh();
  }, [status, tasks, workflows, integrations, reviews, activity]);

  const firstEvent = React.useRef(true);
  React.useEffect(() => {
    if (firstEvent.current) {
      firstEvent.current = false;
      return;
    }
    const timer = setTimeout(refreshAll, 750);
    return () => clearTimeout(timer);
    // Only a NEW event id should schedule a refresh.
  }, [latestEventId, refreshAll]);

  const agents: AgentView[] = status.data?.agents ?? [];
  const taskList = tasks.data ?? [];
  const workflowList = workflows.data ?? [];
  const integrationList = integrations.data ?? [];
  const databaseReady = status.data?.database.ready ?? false;
  const databaseConfigured = status.data?.database.configured ?? false;

  const initialLoading = status.loading && status.data === undefined;
  const fatalError = status.error ?? tasks.error ?? workflows.error;

  return (
    <div className="flex h-dvh flex-col">
      <SystemHeader
        databaseConfigured={databaseConfigured}
        databaseReady={databaseReady}
        realtime={stream.state}
        transports={stream.transports}
        taskCount={taskList.length}
        activityCount={activity.data?.length ?? 0}
        onRefresh={refreshAll}
        refreshing={status.loading || tasks.loading}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3 lg:p-4">
        {fatalError ? (
          <div className="mb-4">
            <ErrorState
              message="The dashboard could not load its data."
              detail={fatalError}
            />
          </div>
        ) : null}

        {stream.state === "DISCONNECTED" && stream.error ? (
          <div className="mb-4">
            <ErrorState message="Realtime is unavailable; showing stored data." detail={stream.error} />
          </div>
        ) : null}

        <div className="mb-3">
          <RecoveryBanner onRecovered={refreshAll} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-4">
            {/* ---- agent cards ---- */}
            <section aria-label="Agents">
              {initialLoading ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <SkeletonRows rows={4} />
                  <SkeletonRows rows={4} />
                </div>
              ) : agents.length === 0 ? (
                <Panel>
                  <PanelHeader>
                    <PanelTitle>Agents</PanelTitle>
                  </PanelHeader>
                  <PanelBody>
                    <p className="text-[11px] text-[var(--content-faint)]">
                      No agents are registered yet. They are created on the first orchestrator run.
                    </p>
                  </PanelBody>
                </Panel>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {agents.map((agent) => (
                    <AgentCard key={agent.id} agent={agent} now={now} />
                  ))}
                </div>
              )}
            </section>

            <Tabs defaultValue="tasks" className="w-full">
              <TabsList className="mb-4">
                <TabsTrigger value="tasks">Tasks & Jobs</TabsTrigger>
                <TabsTrigger value="workflows">Workflows</TabsTrigger>
                <TabsTrigger value="integrations">Integrations ({integrationList.length})</TabsTrigger>
                <TabsTrigger value="reviews">Code Reviews</TabsTrigger>
              </TabsList>

              <TabsContent value="tasks" className="mt-0">
                <Panel>
                  <PanelHeader>
                    <PanelTitle>Task board</PanelTitle>
                    <span className="text-[10px] text-[var(--content-faint)]">
                      {taskList.length} task(s)
                      {tasks.loading ? " · refreshing" : ""}
                    </span>
                  </PanelHeader>
                  <PanelBody className="p-0">
                    {tasks.loading && tasks.data === undefined ? (
                      <div className="p-4"><SkeletonRows rows={3} /></div>
                    ) : tasks.error ? (
                      <div className="p-4"><ErrorState message="Could not load tasks." detail={tasks.error} /></div>
                    ) : (
                      <div className="p-3"><TaskBoard tasks={taskList} now={now} /></div>
                    )}
                  </PanelBody>
                </Panel>
              </TabsContent>

              <TabsContent value="workflows" className="mt-0">
                <Panel>
                  <PanelHeader>
                    <PanelTitle>Workflow board</PanelTitle>
                    <span className="text-[10px] text-[var(--content-faint)]">
                      {workflowList.length} workflow(s)
                      {workflows.loading ? " · refreshing" : ""}
                    </span>
                  </PanelHeader>
                  <PanelBody className="p-0">
                    {workflows.loading && workflows.data === undefined ? (
                      <div className="p-4"><SkeletonRows rows={3} /></div>
                    ) : workflows.error ? (
                      <div className="p-4"><ErrorState message="Could not load workflows." detail={workflows.error} /></div>
                    ) : (
                      <div className="p-3"><WorkflowBoard workflows={workflowList} now={now} /></div>
                    )}
                  </PanelBody>
                </Panel>
              </TabsContent>

              <TabsContent value="integrations" className="mt-0">
                {integrations.loading && integrations.data === undefined ? (
                  <div className="p-4"><SkeletonRows rows={3} /></div>
                ) : integrations.error ? (
                  <div className="p-4"><ErrorState message="Could not load integrations." detail={integrations.error} /></div>
                ) : (
                  <IntegrationBoard candidates={integrationList} now={now} onRefresh={refreshAll} />
                )}
              </TabsContent>

              <TabsContent value="reviews" className="mt-0">
                <ReviewCenter
                  reviews={reviews.data ?? []}
                  loading={reviews.loading}
                  {...(reviews.error ? { error: reviews.error } : {})}
                />
              </TabsContent>
            </Tabs>
          </div>

          {/* ---- right column ---- */}
          <div className="flex min-w-0 flex-col gap-4 xl:h-[calc(100dvh-8rem)]">
            <CreateTaskForm onCreated={refreshAll} />

            <LiveActivity
              realtime={stream.entries}
              historical={activity.data ?? []}
              connected={stream.state === "CONNECTED"}
              className="min-h-[320px] flex-1 panel backdrop-blur-md"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
