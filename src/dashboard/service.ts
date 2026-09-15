/**
 * Dashboard service layer.
 *
 * Sits between the HTTP handlers and the persistence layer. It owns:
 *   - assembling the view models the dashboard reads
 *   - deciding what a control action *means* in terms of state
 *   - publishing the activity/event for every action
 *
 * It contains no SQL: every read goes through a repository. That is what keeps
 * handlers thin and lets the same logic be unit-tested without HTTP.
 */

import type { Logger } from "../domain/logger.js";
import type { AnyTaskEvent, AgentRole, TaskEventPayloadMap, TaskStatus } from "../events/types.js";
import { basename } from "node:path";
import { makeEvent, type EventBus } from "../events/bus.js";
import {
  allowedControlActions,
  explainRefusal,
  isControlAction,
  type ControlAction,
} from "../domain/control.js";
import type { TaskSpec } from "../domain/types.js";
import type { TaskWorker } from "../orchestration/worker.js";
import type { RecoveryService } from "../orchestration/recovery.js";
import type { Persistence } from "../persistence/container.js";
import type { AgentRecord, AgentStatus } from "../persistence/repositories/agent-repository.js";
import type { ActivityLogRecord } from "../persistence/repositories/activity-log-repository.js";
import type { FileChangeRecord } from "../persistence/repositories/file-change-repository.js";
import type { ReviewRecord } from "../persistence/repositories/review-repository.js";
import type { RunRecord } from "../persistence/repositories/run-repository.js";
import type { TaskRecord } from "../persistence/repositories/task-repository.js";
import type { TestResultRecord } from "../persistence/repositories/test-result-repository.js";
import type { ToolCallRecord } from "../persistence/repositories/tool-call-repository.js";
import type { WorkflowRecord, WorkflowNodeRecord } from "../domain/workflow.js";

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface AgentView {
  id: string;
  agentKey: string;
  /** Display name, e.g. "DEEPSEEK" — derived from the configured model. */
  displayName: string;
  role: AgentRole | "orchestrator";
  provider: string;
  model: string;
  status: AgentStatus;
  currentTaskId?: string;
  currentTaskExternalId?: string;
  currentTaskTitle?: string;
  currentCycle?: number;
  /** ISO timestamp of the most recent recorded activity for this agent. */
  lastActivityAt?: string;
  lastActivityType?: string;
  lastActivitySummary?: string;
  lastSeen: string;
  /** Seconds since the agent started working on its current task (no estimates). */
  elapsedSeconds?: number;
}

export interface TaskView {
  id: string;
  externalId: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedAgentId?: string;
  assignedAgentName?: string;
  workspace: string;
  currentCycle: number;
  maxReviewCycles: number;
  stopReason?: string;
  approved: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ActivityView {
  eventId: string;
  eventType: string;
  taskId?: string;
  taskExternalId?: string;
  agentId?: string;
  agentName?: string;
  cycle?: number;
  occurredAt: string;
  payload: Record<string, unknown>;
  /** Human-readable one-liner for the live feed. */
  message: string;
}

export interface SystemStatusView {
  database: { configured: boolean; ready: boolean; warnings: string[] };
  router: { baseUrl: string; coderModel: string; reviewerModel: string };
  counts: { tasks: number; agents: number; activity: number; reviews: number; workers: number };
  agents: AgentView[];
  workers: Array<{ id: string; pid: number; status: string; lastHeartbeat: string; stale: boolean }>;
}

export interface TaskDetailView {
  task: TaskView;
  runs: RunView[];
  reviews: ReviewView[];
  toolCalls: ToolCallView[];
  files: FileView[];
  tests: TestView[];
  activity: ActivityView[];
}

export type WorkflowView = WorkflowRecord;
export type WorkflowNodeView = WorkflowNodeRecord;
export type IntegrationCandidateView = import("../domain/integration.js").IntegrationCandidate;

export interface RunView {
  id: string;
  runId: string;
  status: string;
  agentId?: string;
  agentName?: string;
  cycle: number;
  reason?: string;
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  totalTokens: number;
}

export interface ReviewView {
  id: string;
  taskId: string;
  taskExternalId?: string;
  reviewer: string;
  cycle: number;
  verdict: string;
  severity: string;
  summary: string;
  issues: string[];
  requiredFixes: string[];
  createdAt: string;
}

export interface ToolCallView {
  id: string;
  toolCallId: string;
  tool: string;
  arguments: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  success?: boolean;
  exitCode?: number | null;
  outputSummary?: string;
}

export interface FileView {
  id: string;
  path: string;
  changeType: string;
  summary?: string;
  gitBaseHash?: string;
  occurredAt: string;
}

export interface TestView {
  id: string;
  testKey: string;
  command: string;
  exitCode?: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs?: number;
  outputSummary?: string;
  startedAt: string;
  /** True for the single run the harness treats as the final word. */
  authoritative: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "ServiceError";
    this.status = options.status ?? 400;
    this.code = options.code ?? "invalid_request";
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ControlOutcome {
  ok: boolean;
  task?: TaskView;
  message: string;
  /** The event id recorded for this action (the audit trail entry). */
  eventId?: string;
  /**
   * True when the action was accepted but the actual work is still stopping —
   * a cooperative pause/cancel. The UI can show "stopping…" instead of claiming
   * the state has already changed.
   */
  pending?: boolean;
}

/** Capabilities for one task, so the UI renders exactly what the API allows. */
export interface TaskCapabilities {
  status: TaskStatus;
  /** Control actions currently legal, from the domain control table. */
  actions: ControlAction[];
  /** True while a worker in this process is running the task. */
  running: boolean;
  /** True when the task looks abandoned (no heartbeat within the threshold). */
  stale: boolean;
  /** Milliseconds since the last heartbeat, when known. */
  staleForMs?: number;
}

export interface DashboardService {
  listAgents(): Promise<AgentView[]>;
  getAgent(idOrKey: string): Promise<{ agent: AgentView; recentActivity: ActivityView[]; recentToolCalls: ToolCallView[]; recentReviews: ReviewView[]; stats: Record<string, number> } | undefined>;
  listTasks(options?: { status?: TaskStatus[]; limit?: number }): Promise<TaskView[]>;
  getTask(idOrExternalId: string): Promise<TaskView | undefined>;
  getTaskDetail(idOrExternalId: string): Promise<TaskDetailView | undefined>;
  /** Which control actions are legal right now (drives the button set). */
  getCapabilities(idOrExternalId: string): Promise<TaskCapabilities | undefined>;
  listActivity(options?: { limit?: number; taskId?: string }): Promise<ActivityView[]>;
  listReviews(options?: { limit?: number; taskId?: string }): Promise<ReviewView[]>;
  systemStatus(): Promise<SystemStatusView>;
  
  listWorkflows(options?: { status?: string }): Promise<WorkflowView[]>;
  getWorkflow(id: string): Promise<WorkflowView | undefined>;
  getWorkflowNodes(workflowId: string): Promise<WorkflowNodeView[]>;
  getWorkflowArtifacts(workflowId: string): Promise<unknown[]>;
  listIntegrationCandidates(): Promise<IntegrationCandidateView[]>;
  
  /** Read-only stale scan for the dashboard banner. */
  recoveryReport(): Promise<{ staleCount: number; thresholdSeconds: number; taskIds: string[] }>;
  /** Bulk apply recovery based on the policy. */
  applyRecovery(): Promise<{ recoveredCount: number; detail: Array<{ taskId: string; action: string }> }>;
  /** Applies recovery to one task (the "Recover" button). */
  recoverTask(id: string): Promise<ControlOutcome>;
  predictNextExternalId(): Promise<string>;
  createTask(input: { externalId?: string; autoGenerateId?: boolean; autoPlan?: boolean; title: string; description: string; workspace?: string; acceptanceCriteria?: string[]; maxReviewCycles?: number }): Promise<TaskView | { workflowId: string }>;
  /**
   * Real execution through the worker: claim, run, persist, stream.
   * Returns as soon as the task is claimed so the HTTP request is not held open
   * for the whole run.
   */
  startTask(id: string): Promise<ControlOutcome>;
  pauseTask(id: string, reason?: string): Promise<ControlOutcome>;
  resumeTask(id: string, reason?: string): Promise<ControlOutcome>;
  cancelTask(id: string, reason?: string): Promise<ControlOutcome>;
  retryTask(id: string, reason?: string): Promise<ControlOutcome>;
  approveTask(id: string, reason?: string): Promise<ControlOutcome>;
  approveIntegration(id: string): Promise<void>;
  rejectIntegration(id: string, reason?: string): Promise<void>;
}

export interface DashboardServiceOptions {
  persistence: Persistence;
  logger: Logger;
  /** Used to describe the system in the header without exposing any secret. */
  router: { baseUrl: string; coderModel: string; reviewerModel: string };
  workspaceRoot: string;
  /** Real task execution + cooperative interrupts. Absent = control is refused. */
  worker?: TaskWorker;
  plannerAgent?: import("../agents/planner-agent.js").PlannerAgent;
  integrationCoordinator?: import("../orchestration/integration-coordinator.js").IntegrationCoordinator;
  /** Stale detection / crash recovery. */
  recovery?: RecoveryService;
  /** Resolves the spec to run a task (task file, then the stored row). */
  loadSpec?(task: TaskRecord): Promise<TaskSpec>;
  /** Stale threshold reported to the UI. */
  staleThresholdMs?: number;
  newId?: () => string;
  now?: () => Date;
}

/** "grip/deepseek-v4.1-flash" -> "DEEPSEEK". Real data, no invented branding. */
export function displayNameForModel(model: string): string {
  const slug = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const head = slug.split(/[-_.]/)[0] ?? slug;
  return head.toUpperCase();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guards uuid columns: a non-uuid string makes PostgreSQL error, not return empty. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function createDashboardService(options: DashboardServiceOptions): DashboardService {
  const { persistence, logger } = options;
  const repos = persistence.repositories;
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const staleThresholdMs = options.staleThresholdMs ?? 120_000;

  const publish = async <K extends keyof TaskEventPayloadMap>(
    type: K,
    taskExternalId: string,
    payload: TaskEventPayloadMap[K],
    extra: { agentId?: string; cycle?: number; id?: string } = {},
  ): Promise<string> => {
    const id = extra.id ?? newId();
    const event = makeEvent({
      type: type as Parameters<typeof makeEvent>[0]["type"],
      taskId: taskExternalId,
      payload: payload as never,
      id,
      now,
      ...(extra.agentId ? { agentId: extra.agentId } : {}),
      ...(extra.cycle === undefined ? {} : { cycle: extra.cycle }),
    });
    await persistence.bus.publish(event as unknown as AnyTaskEvent);
    return id;
  };

  // --- mapping helpers ----------------------------------------------------

  const agentsById = async (): Promise<Map<string, AgentRecord>> => {
    const agents = await repos.agents.list();
    return new Map(agents.map((agent) => [agent.id, agent]));
  };

  const toTaskView = (task: TaskRecord, agent?: AgentRecord): TaskView => ({
    id: task.id,
    externalId: task.externalId,
    title: task.title,
    description: task.description,
    status: task.status,
    ...(task.assignedAgentId ? { assignedAgentId: task.assignedAgentId } : {}),
    ...(agent ? { assignedAgentName: agent.agentKey } : {}),
    workspace: task.workspace,
    currentCycle: task.currentCycle,
    maxReviewCycles: task.maxReviewCycles,
    ...(task.stopReason ? { stopReason: task.stopReason } : {}),
    approved: task.approved,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
  });

  const activityMessage = (
    eventType: string,
    payload: Record<string, unknown>,
    agentName: string | undefined,
  ): string => {
    const who = agentName ?? "System";
    const p = payload as Record<string, unknown>;
    switch (eventType) {
      case "TASK_CREATED":
        return `Task created: ${String(p.title ?? "")}`;
      case "TASK_ASSIGNED":
        return `${who} assigned (${String(p.role ?? "")})`;
      case "TASK_STARTED":
        return "Task started";
      case "STATE_CHANGED":
        return `State ${String(p.from ?? "?")} → ${String(p.to ?? "?")}`;
      case "AGENT_STARTED":
        return `${who} started (cycle ${String(p.cycle ?? "?")}, ${String(p.runReason ?? "")})`;
      case "AGENT_FINISHED":
        return `${who} finished (${p.ok ? "ok" : "failed"})`;
      case "TOOL_STARTED":
        return `${who} called ${String(p.tool ?? "?")}`;
      case "TOOL_FINISHED":
        return `${who} → ${String(p.tool ?? "?")} ${p.success ? "ok" : "failed"}${
          p.exitCode === undefined || p.exitCode === null ? "" : ` (exit ${String(p.exitCode)})`
        }`;
      case "FILE_CHANGED":
        return `${who} ${String(p.changeType ?? "changed")} ${String(p.path ?? "")}`;
      case "TEST_STARTED":
        return `Tests started: ${String(p.command ?? "")}`;
      case "TEST_FINISHED":
        return `Tests ${p.passed ? "passed" : "failed"}: ${String(p.command ?? "")}`;
      case "SUBMITTED_FOR_REVIEW":
        return "Submitted for review";
      case "REVIEW_STARTED":
        return `${who} started review (cycle ${String(p.cycle ?? "?")})`;
      case "REVIEW_FINISHED":
        return `${who} ${String(p.verdict ?? "")} (severity ${String(p.severity ?? "")})`;
      case "REVIEW_REJECTED":
        return `${who} rejected (cycle ${String(p.cycle ?? "?")})`;
      case "FIX_STARTED":
        return `Fix cycle started (cycle ${String(p.cycle ?? "?")})`;
      case "TASK_APPROVED":
        return "Task approved";
      case "TASK_COMPLETED":
        return "Task completed";
      case "TASK_FAILED":
        return `Task failed: ${String(p.stopReason ?? "")}`;
      case "TASK_PAUSED":
        return `Task paused: ${String(p.reason ?? "")}`;
      case "TASK_RESUMED":
        return `Task resumed: ${String(p.reason ?? "")}`;
      case "TASK_CANCELLED":
        return `Task cancelled: ${String(p.reason ?? "")}`;
      default:
        return eventType;
    };
  };

  const toActivityView = (
    log: ActivityLogRecord,
    agents: Map<string, AgentRecord>,
    tasksByExternal: Map<string, TaskRecord>,
  ): ActivityView => {
    const agent = log.agentId ? agents.get(log.agentId) : undefined;
    const task = log.taskId ? [...tasksByExternal.values()].find((t) => t.id === log.taskId) : undefined;
    const agentName = agent ? displayNameForModel(agent.model) : undefined;
    return {
      eventId: log.eventId,
      eventType: log.eventType,
      ...(log.taskId ? { taskId: log.taskId } : {}),
      ...(task ? { taskExternalId: task.externalId } : {}),
      ...(log.agentId ? { agentId: log.agentId } : {}),
      ...(agentName ? { agentName } : {}),
      ...(log.cycle === undefined ? {} : { cycle: log.cycle }),
      occurredAt: log.occurredAt,
      payload: log.payload,
      message: activityMessage(log.eventType, log.payload, agentName),
    };
  };

  const toReviewView = (review: ReviewRecord, task?: TaskRecord): ReviewView => ({
    id: review.id,
    taskId: review.taskId,
    ...(task ? { taskExternalId: task.externalId } : {}),
    reviewer: review.reviewer,
    cycle: review.cycle,
    verdict: review.verdict,
    severity: review.severity,
    summary: review.summary,
    issues: review.issues,
    requiredFixes: review.requiredFixes,
    createdAt: review.createdAt,
  });

  const toToolCallView = (call: ToolCallRecord): ToolCallView => ({
    id: call.id,
    toolCallId: call.toolCallId,
    tool: call.tool,
    // Already redacted on the way in; the service never re-expands it.
    arguments: call.arguments,
    startedAt: call.startedAt,
    ...(call.finishedAt ? { finishedAt: call.finishedAt } : {}),
    ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
    ...(call.success === undefined ? {} : { success: call.success }),
    ...(call.exitCode === undefined ? {} : { exitCode: call.exitCode }),
    ...(call.outputSummary ? { outputSummary: call.outputSummary } : {}),
  });

  const toFileView = (file: FileChangeRecord): FileView => ({
    id: file.id,
    path: file.path,
    changeType: file.changeType,
    ...(file.summary ? { summary: file.summary } : {}),
    ...(file.gitBaseHash ? { gitBaseHash: file.gitBaseHash } : {}),
    occurredAt: file.occurredAt,
  });

  const toTestView = (test: TestResultRecord, authoritativeId: string | undefined): TestView => ({
    id: test.id,
    testKey: test.testKey,
    command: test.command,
    ...(test.exitCode === undefined ? {} : { exitCode: test.exitCode }),
    passed: test.passed,
    timedOut: test.timedOut,
    ...(test.durationMs === undefined ? {} : { durationMs: test.durationMs }),
    ...(test.outputSummary ? { outputSummary: test.outputSummary } : {}),
    startedAt: test.startedAt,
    authoritative: authoritativeId !== undefined && test.id === authoritativeId,
  });

  /** Finds a task by uuid or by its human id, without leaking SQL upward. */
  const findTask = async (idOrExternalId: string): Promise<TaskRecord | undefined> => {
    // Only probe the uuid column when the value is a uuid: PostgreSQL errors on
    // a malformed uuid instead of returning no rows, and "TASK-001" is the
    // normal case.
    const byId = isUuid(idOrExternalId) ? await repos.tasks.findById(idOrExternalId) : undefined;
    if (byId) return byId;
    return repos.tasks.findByExternalId(idOrExternalId);
  };

  const describeTask = async (task: TaskRecord): Promise<TaskView> => {
    const agent = task.assignedAgentId ? await repos.agents.findById(task.assignedAgentId) : undefined;
    return toTaskView(task, agent);
  };

  /**
   * Records a control action as a real event. The event is the audit entry; it
   * lands in activity_logs through the same recorder path as orchestrator events.
   */
  const recordAction = async (
    type: "TASK_PAUSED" | "TASK_RESUMED" | "TASK_CANCELLED",
    task: TaskRecord,
    reason: string,
  ): Promise<string> => {
    return publish(type, task.externalId, { reason }, { cycle: task.currentCycle });
  };

  /**
   * Human audit entry (PHASE 6).
   *
   * Every owner action writes one of these *in addition to* the task event, so
   * the journal always answers "who did this, when, and why" without inferring
   * it. `actor: "human"` is the discriminator that keeps a manual approval
   * distinct from an AI verdict.
   */
  const recordHumanAction = async (
    type:
      | "HUMAN_STARTED_TASK"
      | "HUMAN_PAUSED_TASK"
      | "HUMAN_RESUMED_TASK"
      | "HUMAN_CANCELLED_TASK"
      | "HUMAN_RETRIED_TASK"
      | "HUMAN_APPROVED_TASK",
    task: TaskRecord,
    action: string,
    options: {
      note?: string;
      fromStatus?: TaskStatus;
      toStatus?: TaskStatus;
      extra?: Record<string, unknown>;
    } = {},
  ): Promise<string> => {
    const at = now().toISOString();
    const base = {
      actor: "human" as const,
      action,
      taskId: task.externalId,
      timestamp: at,
      ...(options.note ? { note: options.note } : {}),
      ...(options.fromStatus ? { fromStatus: options.fromStatus } : {}),
      ...(options.toStatus ? { toStatus: options.toStatus } : {}),
      ...(options.extra ?? {}),
    };

    const id = newId();
    const event = makeEvent({
      type,
      taskId: task.externalId,
      payload: base as never,
      id,
      now,
      cycle: task.currentCycle,
    });
    await persistence.bus.publish(event as unknown as AnyTaskEvent);
    return id;
  };

  /** Refuses a control action that the control table does not allow. */
  const assertControlAllowed = (task: TaskRecord, action: ControlAction): void => {
    if (!isControlAction(action)) {
      throw new ServiceError(`Unknown control action "${action}"`, { status: 404, code: "unknown_action" });
    }
    if (!allowedControlActions(task.status).includes(action)) {
      const refusal = explainRefusal(task.status, action);
      throw new ServiceError(refusal.message, { status: 409, code: refusal.code });
    }
  };

  /**
   * The spec handed to the orchestrator.
   *
   * A caller may inject a loader (the dashboard reads `tasks/<id>.json`, which
   * carries the acceptance criteria the reviewer grades against). Otherwise the
   * stored row is used, so a task created from the dashboard is still runnable.
   */
  const resolveSpec = async (task: TaskRecord): Promise<TaskSpec> => {
    if (options.loadSpec) return options.loadSpec(task);
    return {
      id: task.externalId,
      title: task.title,
      description: task.description,
      workspacePath: task.workspace,
      workspaceSlug: basename(task.workspace),
    } satisfies TaskSpec;
  };

  /** True when the task looks abandoned, using the same rule as recovery. */
  const stalenessOf = (task: TaskRecord): { stale: boolean; staleForMs?: number } => {
    if (!["CODING", "TESTING", "REVIEW", "FIXING", "REJECTED"].includes(task.status)) {
      return { stale: false };
    }
    const reference = task.heartbeatAt ?? task.startedAt;
    if (!reference) return { stale: false };
    const parsed = Date.parse(reference);
    if (Number.isNaN(parsed)) return { stale: false };
    const staleForMs = Math.max(0, now().getTime() - parsed);
    return staleForMs > staleThresholdMs ? { stale: true, staleForMs } : { stale: false, staleForMs };
  };

  return {
    async listAgents(): Promise<AgentView[]> {
      const agents = await repos.agents.list();
      const tasksByAgent = new Map<string, TaskRecord>();
      const allTasks = await repos.tasks.list({ limit: 500 });
      for (const task of allTasks) {
        if (task.assignedAgentId) tasksByAgent.set(task.assignedAgentId, task);
      }

      const views: AgentView[] = [];
      for (const agent of agents) {
        const current = agent.currentTaskId
          ? allTasks.find((task) => task.id === agent.currentTaskId)
          : undefined;
        const recent = await repos.activityLogs.listForAgent(agent.id, 1);
        const last = recent[0];
        const elapsedFrom = current?.startedAt;

        views.push({
          id: agent.id,
          agentKey: agent.agentKey,
          displayName: displayNameForModel(agent.model),
          role: agent.role,
          provider: agent.provider,
          model: agent.model,
          status: agent.status,
          ...(agent.currentTaskId ? { currentTaskId: agent.currentTaskId } : {}),
          ...(current ? { currentTaskExternalId: current.externalId, currentTaskTitle: current.title } : {}),
          ...(current ? { currentCycle: current.currentCycle } : {}),
          ...(last ? { lastActivityAt: last.occurredAt, lastActivityType: last.eventType } : {}),
          ...(last ? { lastActivitySummary: activityMessage(last.eventType, last.payload, undefined) } : {}),
          lastSeen: agent.lastSeen,
          ...(elapsedFrom && !current?.completedAt
            ? { elapsedSeconds: Math.max(0, Math.floor((now().getTime() - Date.parse(elapsedFrom)) / 1000)) }
            : {}),
        });
      }
      return views;
    },

    async getAgent(idOrKey) {
      // `idOrKey` may be a UUID or a logical key ("coder-agent"). Only query the
      // uuid column when the value could actually be one — PostgreSQL rejects a
      // malformed uuid with an error rather than returning no rows.
      const agent =
        (isUuid(idOrKey) ? await repos.agents.findById(idOrKey) : undefined) ??
        (await repos.agents.findByKey(idOrKey));
      if (!agent) return undefined;

      const current = agent.currentTaskId ? await repos.tasks.findById(agent.currentTaskId) : undefined;
      const recentActivity = await repos.activityLogs.listForAgent(agent.id, 20);
      const agents = await agentsById();
      const tasks = await repos.tasks.list({ limit: 500 });
      const tasksByExternal = new Map(tasks.map((task) => [task.externalId, task]));

      const view: AgentView = {
        id: agent.id,
        agentKey: agent.agentKey,
        displayName: displayNameForModel(agent.model),
        role: agent.role,
        provider: agent.provider,
        model: agent.model,
        status: agent.status,
        ...(agent.currentTaskId ? { currentTaskId: agent.currentTaskId } : {}),
        ...(current ? { currentTaskExternalId: current.externalId, currentTaskTitle: current.title } : {}),
        ...(current ? { currentCycle: current.currentCycle } : {}),
        lastSeen: agent.lastSeen,
        ...(current?.startedAt
          ? { elapsedSeconds: Math.max(0, Math.floor((now().getTime() - Date.parse(current.startedAt)) / 1000)) }
          : {}),
      };

      // Tool calls made by this agent, across its tasks.
      const recentToolCalls: ToolCallView[] = [];
      if (agent.role === "coder") {
        for (const task of tasks.slice(0, 20)) {
          const calls = await repos.toolCalls.listForTask(task.id);
          for (const call of calls) {
            if (call.agentId === agent.id) recentToolCalls.push(toToolCallView(call));
          }
          if (recentToolCalls.length >= 20) break;
        }
      }

      const recentReviews =
        agent.role === "reviewer"
          ? (await repos.reviews.listRecent(20)).map((review) =>
              toReviewView(
                review,
                tasks.find((task) => task.id === review.taskId),
              ),
            )
          : [];

      const stats =
        agent.role === "reviewer"
          ? { ...(await repos.reviews.statsForReviewer(agent.agentKey)) }
          : { ...(await repos.tasks.statsForAgent(agent.id)) };

      return {
        agent: view,
        recentActivity: recentActivity.map((log) => toActivityView(log, agents, tasksByExternal)),
        recentToolCalls: recentToolCalls.slice(0, 20),
        recentReviews,
        stats,
      };
    },

    async listTasks(listOptions = {}): Promise<TaskView[]> {
      const tasks = await repos.tasks.list({
        ...(listOptions.status ? { status: listOptions.status } : {}),
        limit: listOptions.limit ?? 200,
      });
      const agents = await agentsById();
      return tasks.map((task) =>
        toTaskView(task, task.assignedAgentId ? agents.get(task.assignedAgentId) : undefined),
      );
    },

    async getTask(idOrExternalId) {
      const task = await findTask(idOrExternalId);
      return task ? describeTask(task) : undefined;
    },

    async getTaskDetail(idOrExternalId): Promise<TaskDetailView | undefined> {
      const task = await findTask(idOrExternalId);
      if (!task) return undefined;

      const [runs, reviews, toolCalls, files, tests, activity] = await Promise.all([
        repos.runs.listForTask(task.id),
        repos.reviews.listForTask(task.id),
        repos.toolCalls.listForTask(task.id),
        repos.fileChanges.listForTask(task.id),
        repos.testResults.listForTask(task.id),
        repos.activityLogs.listForTask(task.id, { limit: 500 }),
      ]);

      const agents = await agentsById();
      const tasksByExternal = new Map([[task.externalId, task]]);
      const authoritativeTest = await repos.testResults.authoritative(task.id);

      return {
        task: await describeTask(task),
        runs: runs.map((run: RunRecord) => ({
          id: run.id,
          runId: run.runId,
          status: run.status,
          ...(run.agentId ? { agentId: run.agentId } : {}),
          ...(run.agentId && agents.get(run.agentId)
            ? { agentName: agents.get(run.agentId)!.agentKey }
            : {}),
          cycle: run.cycle,
          ...(run.reason ? { reason: run.reason } : {}),
          ...(run.stopReason ? { stopReason: run.stopReason } : {}),
          startedAt: run.startedAt,
          ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
          ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
          totalTokens: run.totalTokens,
        })),
        reviews: reviews.map((review) => toReviewView(review, task)),
        toolCalls: toolCalls.map(toToolCallView),
        files: files.map(toFileView),
        tests: tests.map((test) => toTestView(test, authoritativeTest?.id)),
        activity: activity.map((log) => toActivityView(log, agents, tasksByExternal)),
      };
    },

    async listActivity(listOptions = {}): Promise<ActivityView[]> {
      const agents = await agentsById();
      const tasks = await repos.tasks.list({ limit: 500 });
      const tasksByExternal = new Map(tasks.map((task) => [task.externalId, task]));

      if (listOptions.taskId) {
        const task = await findTask(listOptions.taskId);
        if (!task) return [];
        const logs = await repos.activityLogs.listForTask(task.id, { limit: listOptions.limit ?? 200 });
        return logs.map((log) => toActivityView(log, agents, tasksByExternal));
      }

      const logs = await repos.activityLogs.latest(listOptions.limit ?? 200);
      // Oldest first, so the feed reads top-to-bottom like a log.
      return logs.reverse().map((log) => toActivityView(log, agents, tasksByExternal));
    },

    async listReviews(listOptions = {}): Promise<ReviewView[]> {
      if (listOptions.taskId) {
        const task = await findTask(listOptions.taskId);
        if (!task) return [];
        const reviews = await repos.reviews.listForTask(task.id);
        return reviews.map((review) => toReviewView(review, task));
      }
      const reviews = await repos.reviews.listRecent(listOptions.limit ?? 100);
      const tasks = await repos.tasks.list({ limit: 500 });
      return reviews.map((review) =>
        toReviewView(
          review,
          tasks.find((task) => task.id === review.taskId),
        ),
      );
    },

    async systemStatus(): Promise<SystemStatusView> {
      const [agents, counts, activeWorkers] = await Promise.all([
        this.listAgents(), 
        repos.tasks.countsByStatus(),
        options.persistence.workers?.listActive(staleThresholdMs) ?? Promise.resolve([])
      ]);
      const [totalActivity, totalReviews] = await Promise.all([
        repos.activityLogs.countAll(),
        repos.reviews.countAll(),
      ]);
      const totalTasks = Number(Object.values(counts).reduce((sum: unknown, n: unknown) => Number(sum) + Number(n), 0));

      const nowTime = now().getTime();
      const mappedWorkers = activeWorkers.map((w: any) => {
        const lastHb = Date.parse(w.lastHeartbeat);
        const isStale = nowTime - lastHb > staleThresholdMs;
        return {
          id: w.id,
          pid: w.pid,
          status: w.status,
          lastHeartbeat: w.lastHeartbeat,
          stale: isStale
        };
      });

      return {
        database: {
          configured: true,
          ready: true,
          warnings: persistence.warnings,
        },
        router: {
          baseUrl: options.router.baseUrl,
          coderModel: options.router.coderModel,
          reviewerModel: options.router.reviewerModel,
        },
        counts: {
          tasks: totalTasks,
          agents: agents.length,
          activity: totalActivity,
          reviews: totalReviews,
          workers: mappedWorkers.length,
        },
        agents,
        workers: mappedWorkers,
      };
    },

    /** Which control actions are legal right now (drives the button set). */
    async getCapabilities(idOrExternalId) {
      const task = await findTask(idOrExternalId);
      if (!task) return undefined;
      const staleness = stalenessOf(task);
      return {
        status: task.status,
        actions: [...allowedControlActions(task.status)],
        running: options.worker?.isBusy(task.externalId) ?? false,
        stale: staleness.stale,
        ...(staleness.staleForMs === undefined ? {} : { staleForMs: staleness.staleForMs }),
      };
    },

    async predictNextExternalId(): Promise<string> {
      return repos.tasks.predictNextExternalId();
    },

    async createTask(input): Promise<TaskView | { workflowId: string }> {
      // 1. Complexity Gate: if autoPlan is explicitly requested, invoke PlannerAgent
      if (input.autoPlan) {
        if (!options.plannerAgent) {
          throw new ServiceError("PlannerAgent is not configured", { status: 503, code: "no_planner" });
        }
        if (!options.persistence.workflows) {
          throw new ServiceError("Workflow persistence is not enabled", { status: 503, code: "workflows_disabled" });
        }

        const externalId = input.externalId?.trim() || `WF-${Date.now().toString(36).toUpperCase()}`;
        const workspaceDir = input.workspace || `${options.workspaceRoot}/${externalId}`;
        const objective = `${input.title}\n${input.description}`;

        logger.info("planner.started", { externalId, title: input.title });
        const spec = await options.plannerAgent.plan(objective, { path: workspaceDir });
        const record = await options.persistence.workflows.create(spec);
        const workflowId = record.id;
        
        if (options.persistence.workflowDeps) {
          await options.persistence.workflowDeps.createEdges(workflowId, spec.edges ?? []);
        }
        await options.persistence.workflows.updateStatus(workflowId, "VALIDATED");
        for (const node of spec.nodes) {
          await options.persistence.workflows.evaluateAndTransitionNodeToReady(workflowId, node.key);
        }

        logger.info("planner.finished", { externalId, workflowId, nodesCount: spec.nodes.length });
        
        // Return a shape indicating workflow creation for future V2 UI
        return { workflowId };
      }

      // 2. Default V1 Task Flow
      let task: TaskRecord;

      if (input.autoGenerateId) {
        task = await repos.tasks.createAuto({
          title: input.title.trim(),
          description: input.description.trim(),
          workspace: input.workspace || options.workspaceRoot,
          maxReviewCycles: input.maxReviewCycles ?? 3,
        });
      } else {
        const externalId = input.externalId?.trim() || `TASK-${Date.now().toString(36).toUpperCase()}`;
        const existing = await repos.tasks.findByExternalId(externalId);
        if (existing) {
          throw new ServiceError(`Task ${externalId} already exists`, {
            status: 409,
            code: "duplicate_task",
          });
        }

        task = await repos.tasks.create({
          externalId,
          title: input.title.trim(),
          description: input.description.trim(),
          workspace: input.workspace || `${options.workspaceRoot}/${externalId}`,
          maxReviewCycles: input.maxReviewCycles ?? 3,
        });
      }

      // The TASK_CREATED event is what the recorder journals; the row already
      // exists, so `resolveTaskIdAsync` links it immediately.
      await publish("TASK_CREATED", task.externalId, {
        title: task.title,
        description: task.description,
        workspace: task.workspace,
        maxReviewCycles: task.maxReviewCycles,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
      });

      logger.info("control.task_created", { externalId: task.externalId });
      return describeTask(task);
    },

    /**
     * START executes the task through the worker.
     *
     * This is real execution, not a status flip: the worker claims the task in the
     * database (the double-start guard), runs the orchestrator, and persists every
     * step. `start` returns as soon as the claim succeeds so the HTTP request is
     * not held open for the whole run — the dashboard follows progress over SSE.
     */
    async startTask(id): Promise<ControlOutcome> {
      const task = await findTask(id);
      if (!task) throw new ServiceError("Task not found", { status: 404, code: "not_found" });

      assertControlAllowed(task, "start");

      // No worker wired (persistence-only deployment): refuse rather than pretend.
      if (!options.worker) {
        throw new ServiceError(
          "No worker is attached to this dashboard, so the task cannot be started. Configure PGLITE_DATA_DIR or DATABASE_URL and run the dashboard as the worker.",
          { status: 503, code: "no_worker" },
        );
      }

      const spec = await resolveSpec(task);
      const outcome = await options.worker.start(task.externalId, { spec, reason: "dashboard:start" });

      if (!outcome.ok) {
        // `busy` is the double-start conflict; anything else is a precondition.
        const status = outcome.reason === "busy" ? 409 : outcome.reason === "not-found" ? 404 : 409;
        throw new ServiceError(outcome.message, {
          status,
          code: outcome.reason ?? "start_refused",
        });
      }

      const eventId = await publish(
        "TASK_STARTED",
        task.externalId,
        { workspace: task.workspace, maxReviewCycles: task.maxReviewCycles },
        { cycle: 1 },
      );
      const humanEventId = await recordHumanAction("HUMAN_STARTED_TASK", task, "start", {
        fromStatus: task.status,
        toStatus: "CODING",
      });
      logger.info("control.task_started", { externalId: task.externalId, humanEventId });

      const fresh = (await repos.tasks.findByExternalId(task.externalId)) ?? task;
      return {
        ok: true,
        message: "Task started; the coder is working",
        eventId,
        task: await describeTask(fresh),
      };
    },

    /**
     * PAUSE is cooperative.
     *
     * The interrupt is recorded and the run unwinds at its next safe point; only
     * then does the worker write PAUSED. If no worker owns the task, nothing is
     * marked paused — the task is not left looking stopped while still running.
     */
    async pauseTask(id, reason = "paused by the project owner"): Promise<ControlOutcome> {
      const task = await findTask(id);
      if (!task) throw new ServiceError("Task not found", { status: 404, code: "not_found" });

      if (task.status === "PAUSED") {
        return { ok: true, message: "Task is already paused", task: await describeTask(task) };
      }

      assertControlAllowed(task, "pause");

      const outcome = await options.worker?.pause(task.externalId, { reason });

      if (!outcome?.ok) {
        // A running-unowned task (another process, or a stale run) must not be
        // reported as cleanly paused.
        throw new ServiceError(
          outcome?.message ??
            "No worker is attached to this dashboard, so the run cannot be paused safely.",
          { status: 409, code: outcome?.reason ?? "no_worker" },
        );
      }

      await recordHumanAction("HUMAN_PAUSED_TASK", task, "pause", { note: reason });

      // The worker applies PAUSED when it unwinds; report that honestly.
      return {
        ok: true,
        pending: true,
        message: "Pause requested; the run will stop at its next safe point",
        task: await describeTask(task),
      };
    },

    /**
     * RESUME restores the state the task was paused in.
     *
     * The status was captured by the pause (`resume_status`), so the review cycle
     * and all persisted evidence are intact — resuming does not create a new run.
     */
    async resumeTask(id, reason = "resumed by the project owner"): Promise<ControlOutcome> {
      const task = await findTask(id);
      if (!task) throw new ServiceError("Task not found", { status: 404, code: "not_found" });
      if (task.status !== "PAUSED") {
        throw new ServiceError(`Task is ${task.status}, not PAUSED`, {
          status: 409,
          code: "not_paused",
        });
      }

      // Resume: the interrupt has been honoured (the worker acknowledges it), so
      // clear any leftover request to avoid immediately stopping the next run.
      await repos.interrupts.clear(task.id).catch(() => {});

      const target = (task.resumeStatus as TaskStatus | undefined) ?? "CODING";
      const updated = await repos.tasks.setStatus(task.id, target, {
        transitionSeqBump: true,
        fromStatus: "PAUSED",
      });
      if (!updated) throw new ServiceError("Could not resume task", { status: 409 });

      const eventId = await recordAction("TASK_RESUMED", updated, reason);
      await recordHumanAction("HUMAN_RESUMED_TASK", updated, "resume", {
        note: reason,
        fromStatus: "PAUSED",
        toStatus: target,
      });
      logger.info("control.task_resumed", { externalId: task.externalId, target });

      return {
        ok: true,
        message: `Task resumed into ${target}. Re-run it to continue the pipeline.`,
        eventId,
        task: await describeTask(updated),
      };
    },

    /**
     * CANCEL is cooperative too, but never leaves the task resumable.
     *
     * The run is stopped, the reason is persisted, the request is acknowledged,
     * and the agents are released. A cancelled task cannot return to RUNNING
     * without an explicit Retry.
     */
    async cancelTask(id, reason = "cancelled by the project owner"): Promise<ControlOutcome> {
      const task = await findTask(id);
      if (!task) throw new ServiceError("Task not found", { status: 404, code: "not_found" });
      assertControlAllowed(task, "cancel");

      // Ask the worker to stop first so the run unwinds before the status lands.
      const outcome = await options.worker?.cancel(task.externalId, { reason });

      if (outcome?.ok) {
        await recordHumanAction("HUMAN_CANCELLED_TASK", task, "cancel", { note: reason });
        return {
          ok: true,
          pending: true,
          message: "Cancel requested; the run will stop at its next safe point",
          task: await describeTask(task),
        };
      }

      // The human's decision is authoritative: written WITHOUT a `fromStatus`
      // guard so a run that happens to finish in the same instant cannot leave the
      // task DONE after the owner cancelled it. But we MUST NOT cancel an ALREADY
      // approved or done task (prevents approve/cancel race).
      if (task.status === "DONE" || task.status === "APPROVED") {
        throw new ServiceError("Cannot cancel an already completed task", { status: 409, code: "transition_rejected" });
      }
      const updated = await repos.tasks.setStatus(task.id, "CANCELLED", {
        transitionSeqBump: true,
        clearApproval: true,
        clearCompletion: true,
      });
      if (!updated) throw new ServiceError("Could not cancel task", { status: 409 });

      // Acknowledge the interrupt once the stop has been recorded; clearing it
      // earlier would let a not-yet-unwound run sail past the safe point.
      await repos.interrupts.acknowledge({ taskId: task.id, intent: "cancel", by: "control-service" }).catch(() => {});

      const eventId = await recordAction("TASK_CANCELLED", updated, reason);
      await recordHumanAction("HUMAN_CANCELLED_TASK", updated, "cancel", {
        note: reason,
        fromStatus: task.status,
        toStatus: "CANCELLED",
      });
      logger.info("control.task_cancelled", {
        externalId: task.externalId,
        hadWorker: false,
      });

      return {
        ok: true,
        message: "Task cancelled",
        eventId,
        task: await describeTask(updated),
      };
    },

    /**
     * RETRY re-queues a stopped task for a NEW run.
     *
     * The previous run row is untouched, so the history reads run 1, run 2, … The
     * next `start` claims the task again and creates a fresh run, and per-run
     * artifact keys are scoped to that run, so nothing from run 1 is overwritten.
     */
    async retryTask(id, reason = "retry requested by the project owner"): Promise<ControlOutcome> {
      const task = await findTask(id);
      if (!task) throw new ServiceError("Task not found", { status: 404, code: "not_found" });
      assertControlAllowed(task, "retry");

      // Drop any outstanding interrupt: a re-queued task must not be stopped by
      // the request that stopped the previous attempt.
      await repos.interrupts.clear(task.id).catch(() => {});

      const updated = await repos.tasks.setStatus(task.id, "PENDING", {
        transitionSeqBump: true,
        fromStatus: task.status,
        clearStopReason: true,
        clearApproval: true,
        clearCompletion: true,
      });
      if (!updated) throw new ServiceError("Could not retry task", { status: 409 });

      const eventId = await publish(
        "TASK_STARTED",
        updated.externalId,
        { workspace: updated.workspace, maxReviewCycles: updated.maxReviewCycles },
        { cycle: updated.currentCycle },
      );
      await recordHumanAction("HUMAN_RETRIED_TASK", updated, "retry", {
        note: reason,
        fromStatus: task.status,
        toStatus: "PENDING",
      });
      logger.info("control.task_retried", { externalId: updated.externalId, reason });

      return {
        ok: true,
        message: "Task re-queued; start it to begin a new run",
        eventId,
        task: await describeTask(updated),
      };
    },

    /**
     * MANUAL APPROVE is an owner override for a task the pipeline could not finish.
     *
     * It is recorded as an explicit human action (HUMAN_APPROVED_TASK) with the
     * status it overrode and the reviewer verdict at the time, so the audit trail
     * shows a disagreement rather than pretending the reviewer agreed. The stored
     * review row is never modified.
     */
    async approveTask(id, reason = "manually approved by the project owner"): Promise<ControlOutcome> {
      const task = await findTask(id);
      if (!task) throw new ServiceError("Task not found", { status: 404, code: "not_found" });

      if (task.status === "DONE") {
        return { ok: true, message: "Task is already DONE", task: await describeTask(task) };
      }
      assertControlAllowed(task, "approve");

      // The reviewer's own verdict at this moment, for the audit record.
      const latestReview = await repos.reviews.latestForTask(task.id).catch(() => undefined);

      const viaApproved = task.status !== "APPROVED";
      if (viaApproved) {
        const toApproved = await repos.tasks.transition({
          taskId: task.id,
          eventId: newId(),
          to: "APPROVED",
          reason: `manual override: ${reason}`,
          allowUnlisted: true,
        });
        if (!toApproved.applied && toApproved.skipped !== "duplicate-event") {
          throw new ServiceError(`Could not approve: ${toApproved.detail ?? toApproved.skipped}`, {
            status: 409,
            code: "transition_rejected",
          });
        }
      }

      const done = await repos.tasks.transition({
        taskId: task.id,
        eventId: newId(),
        to: "DONE",
        ...(viaApproved ? { from: "APPROVED" } : {}),
        reason: `manual override: ${reason}`,
        patch: { approved: true, completedAt: now().toISOString() },
      });
      if (!done.applied) {
        throw new ServiceError(`Could not complete: ${done.detail ?? done.skipped}`, {
          status: 409,
          code: "transition_rejected",
        });
      }

      const eventId = await publish(
        "TASK_APPROVED",
        task.externalId,
        { cycle: task.currentCycle, severity: "NONE", reviewer: "project-owner (manual)" },
        { cycle: task.currentCycle },
      );

      // The distinguishing audit entry: who overrode what, and against which verdict.
      await recordHumanAction("HUMAN_APPROVED_TASK", done.task ?? task, "approve", {
        note: reason,
        fromStatus: task.status,
        toStatus: "DONE",
        extra: {
          manual: true,
          ...(latestReview ? { reviewerVerdict: latestReview.verdict } : {}),
        },
      });

      logger.warn("control.manual_approve", {
        externalId: task.externalId,
        reason,
        overrodeStatus: task.status,
        reviewerVerdict: latestReview?.verdict ?? null,
      });

      return { ok: true, message: "Task approved manually", eventId, task: await describeTask(done.task!) };
    },

    async listWorkflows(opts) {
      if (!persistence.workflows) return [];
      // @ts-expect-error Status cast to WorkflowStatus
      return persistence.workflows.list(opts);
    },

    async getWorkflow(id: string) {
      if (!persistence.workflows) return undefined;
      return (await persistence.workflows.findById(id)) ?? undefined;
    },

    async getWorkflowNodes(workflowId: string): Promise<WorkflowNodeView[]> {
      if (!persistence.workflows) return [];
      return persistence.workflows.findNodes(workflowId) as Promise<WorkflowNodeView[]>;
    },

    async getWorkflowArtifacts(workflowId: string): Promise<unknown[]> {
      if (!persistence.workflowArtifacts) return [];
      return persistence.workflowArtifacts.findAll(workflowId);
    },

    async listIntegrationCandidates(): Promise<IntegrationCandidateView[]> {
      if (!persistence.integrationCandidates) return [];
      return persistence.integrationCandidates.list({ limit: 100 });
    },

    async approveIntegration(id: string): Promise<void> {
      if (!options.integrationCoordinator) {
        throw new ServiceError("IntegrationCoordinator is not initialized.", { status: 503 });
      }
      await options.integrationCoordinator.approve(id);
    },

    async rejectIntegration(id: string, reason?: string): Promise<void> {
      if (!options.integrationCoordinator) {
        throw new ServiceError("IntegrationCoordinator is not initialized.", { status: 503 });
      }
      await options.integrationCoordinator.reject(id);
    },

    /** Stale scan for the banner. Read-only: never mutates. */
    async recoveryReport() {
      if (!options.recovery) {
        return { staleCount: 0, thresholdSeconds: Math.round(staleThresholdMs / 1000), taskIds: [] };
      }
      const detected = await options.recovery.detect();
      return {
        staleCount: detected.length,
        thresholdSeconds: Math.round(staleThresholdMs / 1000),
        taskIds: detected.map((action) => action.taskExternalId),
      };
    },
    
    /** Bulk apply recovery based on the policy. */
    async applyRecovery() {
      if (!options.recovery) {
        throw new ServiceError("Recovery is not available in this deployment", {
          status: 503,
          code: "no_recovery",
        });
      }
      const policy = {
        staleTaskStatus: "NEEDS_HUMAN" as TaskStatus,
        markRunsInterrupted: true,
      };
      const result = await options.recovery.recover(policy);
      return {
        recoveredCount: result.applied.length,
        detail: result.applied.map(d => ({ taskId: d.taskExternalId, action: d.taskMoved ? "marked_needs_human" : "none" })),
      };
    },

    /** Recovery for one task, from the dashboard's Recover action. */
    async recoverTask(id): Promise<ControlOutcome> {
      const task = await findTask(id);
      if (!task) throw new ServiceError("Task not found", { status: 404, code: "not_found" });
      if (!options.recovery) {
        throw new ServiceError("Recovery is not available in this deployment", {
          status: 503,
          code: "no_recovery",
        });
      }

      const result = await options.recovery.recoverTask(task.externalId);
      if (!result.ok) throw new ServiceError(result.message, { status: 409, code: "recovery_failed" });

      const fresh = (await repos.tasks.findByExternalId(task.externalId)) ?? task;
      return { ok: true, message: result.message, task: await describeTask(fresh) };
    },
  } satisfies DashboardService;
}
