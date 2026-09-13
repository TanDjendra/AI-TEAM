/**
 * EventRecorder — the bridge between the event bus and the database.
 *
 * Subscribes to the bus and persists each event. This is the ONLY place that
 * writes activity rows from events, so "publish → persist" has exactly one
 * implementation.
 *
 * Responsibilities:
 *   - append every event to activity_logs (idempotent on event id)
 *   - materialise the projection tables: tool_calls, file_changes, test_results,
 *     reviews, agents.status
 *   - remember the run context so rows can be linked to their run
 *   - track failures so the orchestrator can refuse to mark a task DONE when
 *     persistence is fatally broken
 *
 * Design notes:
 *   - `STATE_CHANGED` is written by TaskRepository.transition inside the same
 *     transaction as the status change. The recorder appends it too; the primary
 *     key on event_id makes the second write a no-op. Whichever arrives first
 *     wins, and there is always exactly one row.
 *   - A failure never throws into the pipeline. It is recorded and reported;
 *     `fatalError` is what the orchestrator consults.
 */

import type { Logger } from "../../domain/logger.js";
import { scrubSecrets } from "../../domain/errors.js";
import type { AnyTaskEvent, TaskEventType } from "../../events/types.js";
import type { EventBus } from "../../events/bus.js";
import type { AgentRepository, AgentStatus } from "./agent-repository.js";
import type { ActivityLogRepository } from "./activity-log-repository.js";
import type { FileChangeRepository } from "./file-change-repository.js";
import type { InterruptRepository } from "./interrupt-repository.js";
import type { ReviewRepository } from "./review-repository.js";
import type { RunRepository } from "./run-repository.js";
import type { TaskRepository } from "./task-repository.js";
import type { TestResultRepository } from "./test-result-repository.js";
import type { ToolCallRepository } from "./tool-call-repository.js";
import { AUTHORITATIVE_TEST_KEY } from "./test-result-repository.js";

export interface RecorderRepositories {
  tasks: TaskRepository;
  agents: AgentRepository;
  runs: RunRepository;
  reviews: ReviewRepository;
  activityLogs: ActivityLogRepository;
  toolCalls: ToolCallRepository;
  fileChanges: FileChangeRepository;
  testResults: TestResultRepository;
  /** PHASE 6: cooperative pause/cancel requests. */
  interrupts: InterruptRepository;
}

/**
 * Links a logical task/run to its database identity.
 *
 * `taskId` may be empty for a brand-new task: the TASK_CREATED projection
 * creates the row (idempotently, on external_id) and fills this in.
 */
export interface RunContext {
  externalTaskId: string;
  taskId: string;
  runKey: string;
  runRowId?: string;
  agentKeys?: Record<string, string>;
}

export interface RecorderFailure {
  eventType: TaskEventType | "context";
  eventId: string;
  message: string;
  /** True when the failure means persistence cannot be trusted. */
  fatal: boolean;
}

export interface EventRecorder {
  /** Subscribes to the bus. Returns an unsubscribe function. */
  attach(bus: EventBus): () => void;
  registerRunContext(context: RunContext): void;
  forgetRunContext(externalTaskId: string): void;
  resolveTaskId(externalTaskId: string): string | undefined;
  failures(): readonly RecorderFailure[];
  hasFatalFailure(): boolean;
  stats(): { persisted: number; duplicates: number; projected: number; failures: number };
}

export interface EventRecorderOptions {
  repositories: RecorderRepositories;
  logger: Logger;
  onFailure?: (failure: RecorderFailure) => void;
}

export function createEventRecorder(options: EventRecorderOptions): EventRecorder {
  const { repositories, logger } = options;
  const runContexts = new Map<string, RunContext>();
  const idCache = new Map<string, string>();
  const failures: RecorderFailure[] = [];
  const testCounters = new Map<string, number>();
  const stats = { persisted: 0, duplicates: 0, projected: 0, failures: 0 };
  let fatal = false;

  const record = (failure: RecorderFailure): void => {
    failures.push(failure);
    stats.failures += 1;
    if (failure.fatal) fatal = true;
    logger.error("recorder.failure", {
      eventType: failure.eventType,
      eventId: failure.eventId,
      fatal: failure.fatal,
      error: failure.message,
    });
    options.onFailure?.(failure);
  };

  const toMessage = (error: unknown): string =>
    scrubSecrets(error instanceof Error ? error.message : String(error));

  /**
   * Resolves the external id to tasks.id.
   *
   * Order: run context → id cache → database. The database fallback matters:
   * without it, an event published before the run context is registered (or by a
   * different producer entirely) would be journalled with a NULL task_id and
   * appear to be missing from the task's history.
   */
  const resolveTaskId = (externalTaskId: string): string | undefined => {
    const context = runContexts.get(externalTaskId);
    if (context) return context.taskId;
    return idCache.get(externalTaskId);
  };

  /** Same, but falls back to a lookup. Never throws. */
  const resolveTaskIdAsync = async (externalTaskId: string): Promise<string | undefined> => {
    const cached = resolveTaskId(externalTaskId);
    if (cached) return cached;
    try {
      const row = await repositories.tasks.findByExternalId(externalTaskId);
      if (row) {
        idCache.set(externalTaskId, row.id);
        const context = runContexts.get(externalTaskId);
        if (context) context.taskId = row.id;
        return row.id;
      }
    } catch (error) {
      logger.warn("recorder.task_lookup_failed", {
        externalTaskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return undefined;
  };

  /**
   * Maps a logical agent identity to its database id.
   *
   * Events carry the agent's *key* ("coder-agent", set by the agent as its own
   * id), while `agentKeys` is indexed by *role* ("coder"). Looking that up
   * directly always missed, so every activity row was written with a NULL
   * agent_id and the dashboard could not attribute a single event. Both
   * spellings — and an already-resolved UUID — are accepted here.
   */
  const normalizeAgentKey = (raw: string): string => {
    const lower = raw.toLowerCase();
    if (lower.startsWith("coder")) return "coder";
    if (lower.startsWith("reviewer")) return "reviewer";
    return lower;
  };

  const resolveAgentId = (externalTaskId: string, agentKey?: string): string | undefined => {
    if (!agentKey) return undefined;
    const keys = runContexts.get(externalTaskId)?.agentKeys;
    if (!keys) return undefined;

    const direct = keys[agentKey];
    if (direct) return direct;

    const byRole = keys[normalizeAgentKey(agentKey)];
    if (byRole) return byRole;

    // Already a database id (e.g. an agent reporting its own resolved UUID).
    const known = Object.values(keys);
    return typeof agentKey === "string" && known.includes(agentKey) ? agentKey : undefined;
  };

  const resolveRunRowId = (externalTaskId: string): string | undefined =>
    runContexts.get(externalTaskId)?.runRowId;

  /**
   * The projection step: writes the domain-specific tables for an event.
   * Kept separate from the journal write so a projection failure does not stop
   * the event from being journalled.
   */
  const project = async (event: AnyTaskEvent, taskId: string): Promise<void> => {
    switch (event.type) {
      case "TASK_CREATED": {
        const payload = event.payload;
        await repositories.tasks.create({
          externalId: event.taskId,
          title: payload.title,
          description: payload.description,
          workspace: payload.workspace,
          maxReviewCycles: payload.maxReviewCycles,
        });
        // Cache the real id now that the row exists.
        const created = await repositories.tasks.findByExternalId(event.taskId);
        if (created) {
          idCache.set(event.taskId, created.id);
          const context = runContexts.get(event.taskId);
          if (context && !context.taskId) context.taskId = created.id;
        }
        stats.projected += 1;
        return;
      }

      case "AGENT_STARTED": {
        const agentId = resolveAgentId(event.taskId, event.agentId);
        if (!agentId) return;
        const status: AgentStatus = event.payload.role === "reviewer" ? "REVIEWING" : "WORKING";
        await repositories.agents.setStatus(agentId, status, { currentTaskId: taskId });
        stats.projected += 1;
        return;
      }

      case "AGENT_FINISHED": {
        const agentId = resolveAgentId(event.taskId, event.agentId);
        if (!agentId) return;
        await repositories.agents.setStatus(agentId, event.payload.ok ? "IDLE" : "ERROR", {
          currentTaskId: null,
        });
        stats.projected += 1;
        return;
      }

      case "TOOL_STARTED": {
        await repositories.toolCalls.start({
          toolCallId: event.payload.toolCallId,
          taskId,
          ...(resolveAgentId(event.taskId, event.payload.agentId)
            ? { agentId: resolveAgentId(event.taskId, event.payload.agentId)! }
            : {}),
          tool: event.payload.tool,
          arguments: event.payload.arguments,
          startedAt: event.timestamp,
        });
        stats.projected += 1;
        return;
      }

      case "TOOL_FINISHED": {
        await repositories.toolCalls.finish({
          toolCallId: event.payload.toolCallId,
          taskId,
          success: event.payload.success,
          exitCode: event.payload.exitCode ?? null,
          outputSummary: event.payload.outputSummary,
          finishedAt: event.timestamp,
          durationMs: event.payload.durationMs,
        });
        stats.projected += 1;
        return;
      }

      case "FILE_CHANGED": {
        await repositories.fileChanges.record({
          taskId,
          ...(resolveAgentId(event.taskId, event.payload.agentId)
            ? { agentId: resolveAgentId(event.taskId, event.payload.agentId)! }
            : {}),
          path: event.payload.path,
          changeType: event.payload.changeType,
          summary: event.payload.summary,
          ...(event.payload.gitBaseHash ? { gitBaseHash: event.payload.gitBaseHash } : {}),
          occurredAt: event.timestamp,
        });
        stats.projected += 1;
        return;
      }

      case "TEST_FINISHED": {
        const cycle = event.cycle ?? event.payload.cycle ?? 0;
        // The authoritative run gets the reserved key; every other run gets a
        // stable per-task key so history is preserved.
        let testKey = AUTHORITATIVE_TEST_KEY;
        if (!event.payload.authoritative) {
          const seen = (testCounters.get(event.taskId) ?? 0) + 1;
          testCounters.set(event.taskId, seen);
          testKey = `cycle-${cycle}-run-${seen}`;
        } else {
          testCounters.set(event.taskId, (testCounters.get(event.taskId) ?? 0) + 1);
        }
        await repositories.testResults.save({
          taskId,
          ...(resolveAgentId(event.taskId, event.payload.agentId)
            ? { agentId: resolveAgentId(event.taskId, event.payload.agentId)! }
            : {}),
          cycle,
          testKey,
          command: event.payload.command,
          exitCode: event.payload.exitCode,
          passed: event.payload.passed,
          outputSummary: event.payload.outputSummary,
          startedAt: event.timestamp,
          finishedAt: event.timestamp,
          durationMs: event.payload.durationMs,
        });
        stats.projected += 1;
        return;
      }

      case "REVIEW_FINISHED": {
        await repositories.reviews.save({
          taskId,
          ...(resolveRunRowId(event.taskId) ? { runId: resolveRunRowId(event.taskId)! } : {}),
          reviewer: event.payload.reviewer,
          cycle: event.payload.cycle,
          verdict: event.payload.verdict,
          severity: event.payload.severity,
          summary: event.payload.summary,
          issues: event.payload.issues,
          requiredFixes: event.payload.requiredFixes,
          createdAt: event.timestamp,
        });
        stats.projected += 1;
        return;
      }

      default:
        return;
    }
  };

  return {
    attach(bus: EventBus): () => void {
      return bus.subscribe(async (event) => {
        // 1. Journal first: the event must not be lost because a projection
        //    failed. `append` is idempotent on the event id.
        let inserted = false;
        let taskId: string | undefined;
        try {
          taskId = await resolveTaskIdAsync(event.taskId);
          inserted = await repositories.activityLogs.append({
            eventId: event.id,
            taskId,
            runId: resolveRunRowId(event.taskId),
            agentId: resolveAgentId(event.taskId, event.agentId),
            eventType: event.type,
            cycle: event.cycle,
            payload: event.payload as unknown as Record<string, unknown>,
            occurredAt: event.timestamp,
          });
          if (inserted) stats.persisted += 1;
          else stats.duplicates += 1;
        } catch (error) {
          // Journal failure IS fatal: the audit trail is the source of truth.
          record({
            eventType: event.type,
            eventId: event.id,
            message: toMessage(error),
            fatal: true,
          });
          return;
        }

        // A duplicate means we have already projected this event.
        if (!inserted) return;

        // 2. Projections.
        try {
          if (taskId) await project(event, taskId);
        } catch (error) {
          const message = toMessage(error);
          // Losing a review row would corrupt history; losing a tool row is
          // degraded observability. Both are reported, only the former is fatal.
          record({
            eventType: event.type,
            eventId: event.id,
            message,
            fatal: event.type === "REVIEW_FINISHED",
          });
        }
      });
    },

    registerRunContext(context: RunContext): void {
      runContexts.set(context.externalTaskId, context);
      idCache.set(context.externalTaskId, context.taskId);
    },

    forgetRunContext(externalTaskId: string): void {
      runContexts.delete(externalTaskId);
      testCounters.delete(externalTaskId);
    },

    resolveTaskId,

    failures: () => failures.slice(),
    hasFatalFailure: () => fatal,
    stats: () => ({ ...stats }),
  };
}
