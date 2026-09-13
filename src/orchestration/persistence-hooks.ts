/**
 * Orchestrator persistence hooks.
 *
 * The orchestrator calls these at defined points; this module is the ONLY place
 * that knows about repositories, the bus and the recorder. That keeps the review
 * loop readable and means persistence can be switched off entirely (the hooks
 * are optional) without touching the orchestration logic.
 *
 * Ordering rule that matters:
 *   for a state change, the DATABASE transition is written first (it is atomic
 *   with its own activity row) and the event is published second. The recorder
 *   then sees a duplicate event id and skips the journal write, so there is
 *   exactly one STATE_CHANGED row and it is guaranteed to match tasks.status.
 */

import type { Logger } from "../domain/logger.js";
import type { CoderOutput, ReviewerOutput, TaskSpec, TaskState } from "../domain/types.js";
import { makeEvent, type EventBus } from "../events/bus.js";
import type { AgentRole, AnyTaskEvent, TaskEventType, TaskStatus } from "../events/types.js";
import type { AgentObserver } from "../agents/agent-observer.js";
import type { EventRecorder, RunContext } from "../persistence/repositories/event-recorder.js";
import type { RecorderRepositories } from "../persistence/repositories/event-recorder.js";
import { summarize } from "../persistence/redaction.js";

export interface OrchestratorHooks {
  /** Called once, before the first agent runs. */
  onTaskCreated?(params: {
    spec: TaskSpec;
    workspacePath: string;
    maxReviewCycles: number;
    agentKeys: { coder: string; reviewer: string };
    agentIds: { coder?: string; reviewer?: string };
  }): Promise<void>;

  /** A run row was created for this execution. */
  onRunStarted?(params: { spec: TaskSpec; runKey: string }): Promise<void>;

  /** A run was stopped by a human at a safe point (pause/cancel). */
  onAborted?(params: { intent: "pause" | "cancel"; reason: string }): Promise<void>;

  /** Saves recovery metadata for crash recovery. */
  onCheckpoint?(params: { phase: string; metadata: Record<string, unknown> }): Promise<void>;

  /** Loads recovery metadata to resume a crashed run. */
  loadCheckpoint?(taskId: string): Promise<{ phase?: string; metadata?: Record<string, unknown> } | undefined>;

  /** A state machine transition happened (or was attempted). */
  onStateChanged?(params: {
    from: TaskState | TaskStatus;
    to: TaskState | TaskStatus;
    cycle: number;
    reason?: string;
    /** True when the transition bypasses the state machine (policy stop). */
    policyStop?: boolean;
  }): Promise<void>;

  /** The coder contract is about to be handed to the reviewer. */
  onSubmittedForReview?(params: {
    cycle: number;
    coder: CoderOutput;
  }): Promise<void>;

  /** A review pass produced a verdict. */
  onReviewFinished?(params: { cycle: number; reviewer: ReviewerOutput }): Promise<void>;

  /** A review pass rejected the work. */
  onReviewRejected?(params: {
    cycle: number;
    reviewer: ReviewerOutput;
    willRetry: boolean;
  }): Promise<void>;

  /** A fix run is starting. */
  onFixStarted?(params: { cycle: number; requiredFixes: string[] }): Promise<void>;

  /** The task was approved. */
  onApproved?(params: { cycle: number; reviewer: ReviewerOutput }): Promise<void>;

  /** The task reached a terminal state. */
  onCompleted?(params: {
    state: TaskState;
    approved: boolean;
    reviewCycles: number;
    stopReason?: string;
    coderCalls: number;
    reviewerCalls: number;
    totalTokens: number;
    durationMs: number;
  }): Promise<void>;

  /** The pipeline stopped without approval. */
  onFailed?(params: { stopReason: string; message: string }): Promise<void>;

  /** Observer handed to an agent so its tool calls can be recorded. */
  createObserver(params: {
    agentKey: string;
    role: AgentRole;
    taskId: string;
  }): AgentObserver;

  /** Flush/teardown. */
  close?(): Promise<void>;
}

export interface PersistenceHooksOptions {
  bus: EventBus;
  recorder: EventRecorder;
  repositories: RecorderRepositories;
  logger: Logger;
  /** Stable identifier for this orchestrator execution. */
  runKey: string;
  /** Provider name recorded on agent rows. */
  provider: string;
  models: { coder: string; reviewer: string };
  now?: () => Date;
  newId?: () => string;
  /**
   * Called when persistence fails in a way that means "this run cannot be
   * trusted as complete". The orchestrator turns this into NEEDS_HUMAN.
   */
  onFatal?(message: string): void;
}

export function createPersistenceHooks(options: PersistenceHooksOptions): OrchestratorHooks {
  const { bus, recorder, repositories, logger } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());

  /** External task id currently being run (events use it as `taskId`). */
  let externalTaskId = "";
  /**
   * Run key for the CURRENT execution.
   *
   * Deliberately not the constructor value: a task can be retried, and each
   * execution must create its OWN run row (run 1, run 2, …). Reusing one key
   * made `runs.start` conflict on `run_id` and overwrite the previous run, which
   * destroyed the attempt history the dashboard shows.
   */
  let currentRunKey = options.runKey;
  /**
   * Whether the current run row has already been closed.
   *
   * Guards `onAborted` and `onCompleted` from double-closing the same run, so the
   * first outcome (a deliberate stop) wins and a late finish cannot overwrite it.
   */
  let runClosed = false;
  let context: RunContext | undefined;

  const publish = async <K extends TaskEventType>(
    type: K,
    payload: Parameters<typeof makeEvent<K>>[0]["payload"],
    extra: { agentId?: string; cycle?: number; id?: string; timestamp?: string } = {},
  ): Promise<void> => {
    const event = makeEvent<K>({
      type,
      taskId: externalTaskId,
      payload,
      newId,
      now,
      ...(extra.id ? { id: extra.id } : {}),
      ...(extra.timestamp ? { timestamp: extra.timestamp } : {}),
      ...(extra.agentId ? { agentId: extra.agentId } : {}),
      ...(extra.cycle === undefined ? {} : { cycle: extra.cycle }),
    });
    try {
      // `makeEvent` returns the precise TaskEvent<K>; the bus takes the union.
      await bus.publish(event as unknown as AnyTaskEvent);
    } catch (error) {
      // The bus already reports transport/listener failures; this is a final
      // safety net so a publish problem cannot crash a run.
      logger.error("hooks.publish_failed", {
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Agent keys → ids, resolved lazily and cached by the recorder. */
  const agentKeys: { coder: string; reviewer: string } = { coder: "", reviewer: "" };
  const agentIds: { coder?: string; reviewer?: string } = {};

  return {
    async onTaskCreated(params) {
      externalTaskId = params.spec.id;
      // One run key per execution, derived from the task and a timestamp so a
      // retry never collides with the run it replaces.
      currentRunKey = `${params.spec.id}#${now().getTime().toString(36)}`;
      runClosed = false;
      agentKeys.coder = params.agentKeys.coder;
      agentKeys.reviewer = params.agentKeys.reviewer;
      agentIds.coder = params.agentIds.coder;
      agentIds.reviewer = params.agentIds.reviewer;

      // The task row must exist before any event references it.
      let taskRow = await repositories.tasks.findByExternalId(params.spec.id);
      if (!taskRow) {
        taskRow = await repositories.tasks.create({
          externalId: params.spec.id,
          title: params.spec.title,
          description: params.spec.description,
          workspace: params.workspacePath,
          maxReviewCycles: params.maxReviewCycles,
        });
      }

      const runRow = await repositories.runs.start({
        taskId: taskRow.id,
        runId: currentRunKey,
        cycle: 0,
        reason: "orchestrator",
      });

      context = {
        externalTaskId: params.spec.id,
        taskId: taskRow.id,
        runKey: currentRunKey,
        runRowId: runRow.id,
        agentKeys: Object.fromEntries(
          Object.entries(agentIds).filter(([, id]) => Boolean(id)) as Array<[string, string]>,
        ),
      };
      recorder.registerRunContext(context);

      await publish("TASK_CREATED", {
        title: params.spec.title,
        description: params.spec.description,
        workspace: params.workspacePath,
        maxReviewCycles: params.maxReviewCycles,
        acceptanceCriteria: params.spec.acceptanceCriteria ?? [],
      });

      for (const [role, agentId] of Object.entries(agentIds) as Array<[AgentRole, string?]>) {
        if (!agentId) continue;
        await publish(
          "TASK_ASSIGNED",
          {
            agentId,
            role,
            provider: options.provider,
            model: role === "coder" ? options.models.coder : options.models.reviewer,
            cycle: 1,
          },
          // Attributes the assignment to the agent it was given to, so the
          // agent's activity feed can show what it was assigned.
          { agentId, cycle: 1 },
        );
      }

      await publish("TASK_STARTED", {
        workspace: params.workspacePath,
        maxReviewCycles: params.maxReviewCycles,
      });
    },

    async onRunStarted() {
      // The run row was created in onTaskCreated; nothing more to do.
    },

    async onCheckpoint(params) {
      if (!context?.taskId) return;
      try {
        await repositories.tasks.updateCheckpoint(context.taskId, params.phase, params.metadata);
        await repositories.runs.updateCheckpoint(currentRunKey, params.metadata);
      } catch (error) {
        logger.error("hooks.checkpoint_failed", {
          taskId: externalTaskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async loadCheckpoint(taskId: string) {
      const task = await repositories.tasks.findByExternalId(taskId);
      if (!task) return undefined;
      return { phase: task.currentPhase, metadata: task.recoveryMetadata };
    },

    /**
     * Persists the transition and publishes STATE_CHANGED with the SAME event id.
     * If the database rejects the transition, no event is published, so the
     * event stream can never claim a state change that did not happen.
     */
    async onStateChanged(params) {
      if (!context) return;
      const eventId = newId();

      // The stop reason is part of the task's persisted state, not just the
      // event: a dashboard must be able to read why a task needs a human without
      // replaying the journal.
      const patch: {
        stopReason?: string | null;
        approved?: boolean;
        completedAt?: string | null;
      } = {};
      if (params.policyStop && params.reason) patch.stopReason = params.reason;
      if (params.to === "DONE") {
        patch.approved = true;
        patch.completedAt = now().toISOString();
      }

      const outcome = await repositories.tasks.transition({
        taskId: context.taskId,
        eventId,
        to: params.to as TaskStatus,
        cycle: params.cycle,
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.policyStop ? { allowUnlisted: true } : {}),
        ...(Object.keys(patch).length > 0 ? { patch } : {}),
      });

      if (!outcome.applied && outcome.skipped !== "duplicate-event") {
        // A rejected transition is a real problem: the in-memory record and the
        // database have diverged.
        const message = `could not persist transition ${String(params.from)} -> ${String(params.to)}: ${
          outcome.detail ?? outcome.skipped ?? "unknown reason"
        }`;
        logger.error("hooks.transition_rejected", { detail: message });
        options.onFatal?.(message);
      }

      // Same id => the recorder's journal write dedupes against the row written
      // by the transition above.
      await publish(
        "STATE_CHANGED",
        {
          from: params.from as TaskStatus,
          to: params.to as TaskStatus,
          cycle: params.cycle,
          ...(params.reason ? { reason: params.reason } : {}),
        },
        { id: eventId, cycle: params.cycle },
      );
    },

    async onSubmittedForReview({ cycle, coder }) {
      await publish(
        "SUBMITTED_FOR_REVIEW",
        {
          cycle,
          coderStatus: coder.status,
          filesChanged: coder.files_changed.length,
          testsPassed: coder.tests_passed,
        },
        { cycle },
      );
    },

    async onReviewFinished({ cycle, reviewer }) {
      await publish(
        "REVIEW_FINISHED",
        {
          reviewer: reviewer.agentId,
          cycle,
          verdict: reviewer.verdict,
          severity: reviewer.severity,
          issues: reviewer.issues,
          requiredFixes: reviewer.required_fixes,
          summary: summarize(reviewer.summary),
        },
        { agentId: agentIds.reviewer, cycle },
      );
    },

    async onReviewRejected({ cycle, reviewer, willRetry }) {
      await publish(
        "REVIEW_REJECTED",
        {
          cycle,
          severity: reviewer.severity,
          requiredFixes: reviewer.required_fixes,
          willRetry,
        },
        { cycle },
      );
    },

    async onFixStarted({ cycle, requiredFixes }) {
      await publish("FIX_STARTED", { cycle, attempt: 1, requiredFixes }, { cycle });
    },

    async onApproved({ cycle, reviewer }) {
      await publish(
        "TASK_APPROVED",
        { cycle, severity: reviewer.severity, reviewer: reviewer.agentId },
        { cycle },
      );
    },

    /**
     * A run stopped by a human at a safe point.
     *
     * The run row is closed as CANCELLED so it is not later mistaken for an
     * abandoned run by stale detection. The task status itself is written by the
     * worker, which knows whether the request was a pause or a cancel.
     */
    async onAborted({ intent, reason }) {
      if (runClosed) return;
      runClosed = true;
      await repositories.runs
        .finish({
          runId: currentRunKey,
          status: "CANCELLED",
          stopReason: intent === "pause" ? "PAUSED_BY_HUMAN" : "CANCELLED_BY_HUMAN",
        })
        .catch((error: unknown) => {
          logger.warn("hooks.abort_finish_failed", {
            runId: currentRunKey,
            reason,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },

    async onCompleted(params) {
      if (runClosed) return;
      runClosed = true;
      if (params.approved) {
        await publish("TASK_COMPLETED", {
          cycles: params.reviewCycles,
          durationMs: params.durationMs,
        });
      } else {
        await publish("TASK_FAILED", {
          stopReason: params.stopReason ?? "UNKNOWN",
          message: `stopped after ${params.reviewCycles} review cycle(s)`,
        });
      }

      // Close the run row so recovery does not treat a finished run as stale.
      await repositories.runs.finish({
        runId: currentRunKey,
        status: params.approved ? "COMPLETED" : "FAILED",
        ...(params.stopReason ? { stopReason: params.stopReason } : {}),
        totalTokens: params.totalTokens,
      });

      // Agents go back to IDLE once the orchestrator is done with them.
      for (const [role, agentId] of Object.entries(agentIds) as Array<[AgentRole, string?]>) {
        if (!agentId) continue;
        await repositories.agents.setStatus(agentId, "IDLE", { currentTaskId: null });
        void role;
      }

      if (context) recorder.forgetRunContext(context.externalTaskId);
      context = undefined;
    },

    async onFailed({ stopReason, message }) {
      await publish("TASK_FAILED", { stopReason, message: summarize(message, 500) });
      if (context) {
        await repositories.runs.finish({
          runId: currentRunKey,
          status: "FAILED",
          stopReason,
        });
      }
    },

    createObserver({ agentKey, role, taskId }): AgentObserver {
      const agentId = agentIds[role];
      return {
        onAgentStarted: async (info) => {
          await publish(
            "AGENT_STARTED",
            {
              agentId: info.agentId,
              role,
              model: info.model,
              cycle: info.cycle,
              attempt: info.attempt,
              runReason: info.runReason,
            },
            { agentId, cycle: info.cycle },
          );
        },
        onAgentFinished: async (info) => {
          await publish(
            "AGENT_FINISHED",
            {
              agentId: info.agentId,
              role,
              ok: info.ok,
              durationMs: info.durationMs,
              ...(info.resolvedModel ? { resolvedModel: info.resolvedModel } : {}),
              ...(info.promptTokens === undefined ? {} : { promptTokens: info.promptTokens }),
              ...(info.completionTokens === undefined
                ? {}
                : { completionTokens: info.completionTokens }),
              ...(info.cachedTokens === undefined ? {} : { cachedTokens: info.cachedTokens }),
              ...(info.inputTokens === undefined ? {} : { inputTokens: info.inputTokens }),
              ...(info.outputTokens === undefined ? {} : { outputTokens: info.outputTokens }),
              ...(info.latencyMs === undefined ? {} : { latencyMs: info.latencyMs }),
            },
            { agentId, cycle: info.cycle },
          );
        },
        onToolStarted: async (info) => {
          await publish(
            "TOOL_STARTED",
            {
              toolCallId: info.toolCallId,
              tool: info.tool,
              arguments: info.arguments,
              agentId: info.agentId,
              cycle: info.cycle,
            },
            { agentId, cycle: info.cycle },
          );
        },
        onToolFinished: async (info) => {
          await publish(
            "TOOL_FINISHED",
            {
              toolCallId: info.toolCallId,
              tool: info.tool,
              agentId: info.agentId,
              cycle: info.cycle,
              success: info.success,
              durationMs: info.durationMs,
              ...(info.exitCode === undefined ? {} : { exitCode: info.exitCode }),
              outputSummary: info.outputSummary,
            },
            { agentId, cycle: info.cycle },
          );

          // A test-class command is reported by onTestFinished — once, with the
          // harness's own pass/fail derivation and an authoritative marker.
          // Emitting a second TEST_FINISHED here duplicated every command with a
          // contradictory `passed` (tool success instead of the exit code) and a
          // command string scraped from the first line of output, so one test
          // appeared twice with opposite results in the dashboard and in the
          // task report. The event is owned by onTestFinished alone.
        },
        onFileChanged: async (info) => {
          await publish(
            "FILE_CHANGED",
            {
              agentId: info.agentId,
              path: info.path,
              changeType: info.changeType,
              summary: info.summary,
            },
            // The file was changed BY this agent, so the row must carry its id.
            // This previously published `agentId: undefined`, which left the
            // event-level id empty and wrote every file change with a NULL
            // agent_id — the Files tab could not attribute a single edit.
            { agentId: info.agentId, cycle: info.cycle },
          );
        },
        onTestFinished: async (info) => {
          await publish(
            "TEST_FINISHED",
            {
              agentId: info.agentId,
              testKey: `${taskId}:${info.cycle}:${info.authoritative ? "final" : "history"}`,
              command: info.command,
              cycle: info.cycle,
              exitCode: info.exitCode,
              passed: info.passed,
              durationMs: info.durationMs,
              outputSummary: info.outputSummary,
              authoritative: info.authoritative,
            },
            { agentId, cycle: info.cycle },
          );
        },
      };
    },

    async close() {
      if (context) recorder.forgetRunContext(context.externalTaskId);
      context = undefined;
      currentRunKey = options.runKey;
    },
  };
}

/** A hooks implementation that does nothing, used when persistence is disabled. */
export const nullHooks: OrchestratorHooks = {
  createObserver: () => ({
    onAgentStarted: async () => {},
    onAgentFinished: async () => {},
    onToolStarted: async () => {},
    onToolFinished: async () => {},
    onFileChanged: async () => {},
    onTestFinished: async () => {},
  }),
};

export type { RecorderRepositories };
