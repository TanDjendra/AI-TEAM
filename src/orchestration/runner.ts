/**
 * OrchestratorService — the review loop.
 *
 * Primary flow, walked as EXPLICIT state transitions (each one validated by the
 * state machine, so an illegal flow throws instead of silently proceeding):
 *
 *   PENDING -> CODING -> TESTING -> REVIEW
 *   REVIEW -> APPROVED -> DONE              (approved)
 *   REVIEW -> REJECTED -> FIXING -> TESTING -> REVIEW   (rejected, loop)
 *
 * Exhaustion: before entering a review pass the orchestrator asks the policy
 * layer whether budget remains. When MAX_REVIEW_CYCLES is spent it stops with
 * NEEDS_HUMAN rather than looping forever. `reviewCycles` is incremented as a
 * pass is entered, so maxReviewCycles = 3 admits exactly 3 review passes.
 *
 * Reviewer independence: the reviewer is invoked for every cycle, including the
 * final one, so a task can only reach DONE through an APPROVED verdict. There is
 * no "give up and ship it" path.
 */

import { join } from "node:path";

import type { AppConfig } from "../config/env.js";
import {
  isCoderOutput,
  isReviewerOutput,
  type Agent,
  type AgentAttempt,
  type AgentInput,
  type CoderOutput,
  type CycleRecord,
  type ReviewerOutput,
  type StopReason,
  type TaskRecord,
  type TaskSpec,
  type TaskState,
  type TestAssessment,
} from "../domain/types.js";
import { scrubSecrets, toRouterError, BudgetExceededError } from "../domain/errors.js";
import { isTaskInterrupt, type ControlAction } from "../domain/control.js";
import type { Logger } from "../domain/logger.js";
import {
  assertTransition,
  reachableTerminal,
  reviewBudgetDecision,
} from "../domain/task-machine.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { AgentObserver } from "../agents/agent-observer.js";
import { TaskInterruptError } from "../domain/control.js";
import { nullHooks, type OrchestratorHooks } from "./persistence-hooks.js";
import { Workspace } from "../agents/workspace.js";

export interface OrchestratorOptions {
  provider: ModelProvider;
  config: AppConfig;
  logger: Logger;
  createCoder(workspace: Workspace, observer: AgentObserver): Agent;
  createReviewer(workspace: Workspace, observer: AgentObserver): Agent;
  /** Hook to create/prepare the sandbox before the first agent call. */
  prepareWorkspace?(task: TaskSpec, workspacePath: string): Promise<void>;
  /** Injectable clock for deterministic tests. */
  clock?: () => Date;
  /**
   * Persistence/event hooks. Optional: with no hooks the orchestrator behaves
   * exactly as before (in-memory only).
   */
  hooks?: OrchestratorHooks;
  /**
   * Consulted before a task is allowed to become DONE. Returning a string means
   * "persistence is not trustworthy" and forces NEEDS_HUMAN instead of DONE.
   */
  completionBlocker?: () => string | undefined;
  /**
   * Cooperative-interrupt hook (PHASE 6), per run.
   *
   * Called at safe points: before an agent call, before a tool execution and
   * before each review pass. Returning a request unwinds the run at that point.
   * Optional, so an orchestrator without human control behaves exactly as before.
   */
  checkInterrupt?: () => { intent: "pause" | "cancel"; reason: string; actor?: string } | undefined;
  /** Resolves the persisted agent ids so events can reference them. */
  resolveAgentIds?: () => Promise<{ coder?: string; reviewer?: string }>;
  /**
   * Cancels an in-flight model/tool call. When present, an interrupt can stop a
   * slow request instead of waiting for it to finish.
   */
  interruptSignal?: AbortSignal;
}

/** Stable logical agent keys, matching agents.agent_key in the database. */
export const CODER_AGENT_KEY = "coder-agent";
export const REVIEWER_AGENT_KEY = "reviewer-agent";

export function workspacePathFor(workspaceRoot: string, task: TaskSpec): string {
  if (task.workspacePath) return task.workspacePath;
  const slug = task.workspaceSlug ?? task.id;
  return join(workspaceRoot, slug);
}

export class OrchestratorService {
  private readonly provider: ModelProvider;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly createCoder: (workspace: Workspace, observer: AgentObserver) => Agent;
  private readonly createReviewer: (workspace: Workspace, observer: AgentObserver) => Agent;
  private readonly prepareWorkspace: (task: TaskSpec, workspacePath: string) => Promise<void>;
  private readonly clock: () => Date;
  private readonly hooks: OrchestratorHooks;
  private readonly completionBlocker?: () => string | undefined;
  private readonly resolveAgentIdsFn?: () => Promise<{ coder?: string; reviewer?: string }>;
  /** Set per run by `run()`; read at safe points. */
  private checkInterrupt?: () => { intent: "pause" | "cancel"; reason: string; actor?: string } | undefined;

  constructor(options: OrchestratorOptions) {
    this.provider = options.provider;
    this.config = options.config;
    this.logger = options.logger;
    this.createCoder = options.createCoder;
    this.createReviewer = options.createReviewer;
    this.prepareWorkspace = options.prepareWorkspace ?? (async () => {});
    this.clock = options.clock ?? (() => new Date());
    this.hooks = options.hooks ?? nullHooks;
    this.completionBlocker = options.completionBlocker;
    this.resolveAgentIdsFn = options.resolveAgentIds;
  }

  private async resolveAgentIds(): Promise<{ coder?: string; reviewer?: string }> {
    if (!this.resolveAgentIdsFn) return {};
    try {
      return await this.resolveAgentIdsFn();
    } catch (error) {
      this.logger.warn("run.resolve_agents_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  /**
   * Runs one task with a cooperative interrupt source (PHASE 6).
   *
   * `checkInterrupt` is called at safe points only. It is a *parameter* of `run`
   * rather than a constructor option because the answer is per-run state: two
   * tasks running at once must not share one interrupt answer.
   */
  async run(
    spec: TaskSpec,
    options: { checkInterrupt?: () => { intent: "pause" | "cancel"; reason: string; actor?: string } | undefined } = {},
  ): Promise<TaskRecord> {
    this.checkInterrupt = options.checkInterrupt;
    return this.execute(spec);
  }

  /**
   * Raises the cooperative interrupt if a human asked for one, and aborts if
   * token or turn budgets have been exceeded.
   */
  private assertProceed(record: TaskRecord, log: Logger): void {
    const request = this.checkInterrupt?.();
    if (request) throw new TaskInterruptError(request);
    
    const budgetExceededReason = this.checkBudgets(record, log);
    if (budgetExceededReason) {
      throw new BudgetExceededError(budgetExceededReason);
    }
  }

  /** The run itself. See the class header for the state flow. */
  private async execute(spec: TaskSpec): Promise<TaskRecord> {
    const workspacePath = workspacePathFor(this.config.orchestrator.workspaceRoot, spec);
    const workspace = new Workspace(workspacePath, { createIfNotExists: !spec.workspacePath });

    const record: TaskRecord = {
      id: spec.id,
      spec,
      state: "PENDING",
      reviewCycles: 0,
      approved: false,
      history: ["PENDING"],
      attempts: [],
      cycles: [],
      workspacePath,
      startedAt: this.nowIso(),
      notes: [],
    };

    const log = this.logger.child({ taskId: spec.id, workspace: workspacePath });
    log.info("run.start", { title: spec.title, maxReviewCycles: this.config.orchestrator.maxReviewCycles });

    try {
      await this.prepareWorkspace(spec, workspacePath);

      // Persistence is notified before any agent runs so the task row and run
      // row exist before events reference them.
      await this.hooks.onTaskCreated?.({
        spec,
        workspacePath,
        maxReviewCycles: this.config.orchestrator.maxReviewCycles,
        agentKeys: { coder: CODER_AGENT_KEY, reviewer: REVIEWER_AGENT_KEY },
        agentIds: await this.resolveAgentIds(),
      });

      const coderObserver = this.hooks.createObserver({
        agentKey: CODER_AGENT_KEY,
        role: "coder",
        taskId: spec.id,
      });
      const reviewerObserver = this.hooks.createObserver({
        agentKey: REVIEWER_AGENT_KEY,
        role: "reviewer",
        taskId: spec.id,
      });

      const coder = this.createCoder(workspace, coderObserver);
      const reviewer = this.createReviewer(workspace, reviewerObserver);

      const checkpoint = await this.hooks.loadCheckpoint?.(spec.id);
      const resumedPhase = checkpoint?.phase;
      const resumedMetadata = checkpoint?.metadata as any;
      let currentCycle = resumedMetadata?.cycle ?? 1;

      // ---- PENDING -> CODING ----
      this.assertProceed(record, log);
      await this.transition(record, "CODING", log);
      await this.hooks.onCheckpoint?.({
        phase: "CODING",
        metadata: { cycle: currentCycle },
      });

      let coderOutput = await this.runCoder({
        record,
        agent: coder,
        workspace,
        cycle: currentCycle,
        reason: "INITIAL",
        task: spec,
        log,
      });
      record.cycles.push({ cycle: currentCycle, coder: coderOutput });

      if (this.isInfrastructureFailure(coderOutput)) {
        await this.stopByPolicy(record, "CODER_UNAVAILABLE", log, [
          `Coder produced no usable output: ${coderOutput.issues.join("; ") || coderOutput.summary}`,
        ]);
        return await this.finish(record, log);
      }
      await this.transition(record, "TESTING", log);
      await this.hooks.onCheckpoint?.({
        phase: "TESTING",
        metadata: { cycle: currentCycle, coderTokens: coderOutput.usage?.totalTokens },
      });
      this.assessTesting(record, currentCycle, coderOutput, log);

      // ---- review loop ----
      // Invariant at the top of each iteration: state === TESTING.
      for (;;) {
        const budget = reviewBudgetDecision(record.reviewCycles, {
          maxReviewCycles: this.config.orchestrator.maxReviewCycles,
        });

        if (budget.stop) {
          await this.stopByPolicy(record, budget.reason ?? "MAX_REVIEW_CYCLES", log, [
            `Review budget exhausted after ${record.reviewCycles} pass(es) without approval.`,
          ]);
          break;
        }

        // Cooperative stop: the reviewer doesn't loop, but check it before
        // the single large chunk of work (and inside if it iterates).
        this.assertProceed(record, log);

        // TESTING -> REVIEW
        await this.hooks.onSubmittedForReview?.({ cycle: currentCycle + 1, coder: coderOutput });
        await this.transition(record, "REVIEW", log);
        currentCycle = record.reviewCycles + 1;
        record.reviewCycles = currentCycle;
        await this.hooks.onCheckpoint?.({
          phase: "REVIEW",
          metadata: { cycle: currentCycle },
        });

        const cycle = this.ensureCycle(record, currentCycle);
        cycle.coder = coderOutput;

        const reviewerOutput = await this.runReviewer({
          record,
          agent: reviewer,
          workspace,
          cycle: currentCycle,
          task: spec,
          coderOutput,
          log,
        });
        cycle.reviewer = reviewerOutput;

        if (this.isInfrastructureFailure(reviewerOutput)) {
          await this.stopByPolicy(record, "REVIEWER_UNAVAILABLE", log, [
            `Reviewer produced no usable verdict: ${reviewerOutput.error ?? reviewerOutput.summary}`,
          ]);
          break;
        }

        // The review is recorded before the verdict is acted on, so a review can
        // never exist in the event stream without its row.
        await this.hooks.onReviewFinished?.({ cycle: currentCycle, reviewer: reviewerOutput });

        if (reviewerOutput.verdict === "APPROVED") {
          // Persistence must be trustworthy before DONE is claimed.
          const blocker = this.completionBlocker?.();
          if (blocker) {
            log.error("run.completion_blocked", { reason: blocker });
            record.notes.push(`Persistence unhealthy: ${blocker}`);
            await this.stopByPolicy(record, "INVALID_AGENT_OUTPUT", log, [
              `Task was approved by the reviewer but could not be marked DONE: ${blocker}`,
            ]);
            break;
          }

          await this.hooks.onApproved?.({ cycle: currentCycle, reviewer: reviewerOutput });
          await this.transition(record, "APPROVED", log);
          record.approved = true;
          await this.transition(record, "DONE", log);
          log.info("run.approved", { cycles: record.reviewCycles });
          break;
        }

        // ---- rejected ----
        await this.transition(record, "REJECTED", log);

        const remaining = reviewBudgetDecision(record.reviewCycles, {
          maxReviewCycles: this.config.orchestrator.maxReviewCycles,
        });
        await this.hooks.onReviewRejected?.({
          cycle: currentCycle,
          reviewer: reviewerOutput,
          willRetry: !remaining.stop,
        });

        if (remaining.stop) {
          await this.stopByPolicy(record, remaining.reason ?? "MAX_REVIEW_CYCLES", log, [
            `Rejected on the final permitted review pass (severity ${reviewerOutput.severity}).`,
          ]);
          break;
        }

        await this.transition(record, "FIXING", log);
        await this.hooks.onFixStarted?.({
          cycle: currentCycle + 1,
          requiredFixes: reviewerOutput.required_fixes,
        });

        const nextCycle = currentCycle + 1;
        await this.hooks.onCheckpoint?.({
          phase: "FIXING",
          metadata: { cycle: nextCycle, reviewerSeverity: reviewerOutput.severity },
        });

        coderOutput = await this.runCoder({
          record,
          agent: coder,
          workspace,
          cycle: nextCycle,
          reason: "FIX",
          task: spec,
          previousReview: reviewerOutput,
          log,
        });

        if (this.isInfrastructureFailure(coderOutput)) {
          await this.stopByPolicy(record, "CODER_UNAVAILABLE", log, [
            `Coder produced no usable output while fixing cycle ${currentCycle}.`,
          ]);
          break;
        }

        await this.transition(record, "TESTING", log);
        this.assessTesting(record, nextCycle, coderOutput, log);
      }
    } catch (error) {
      // A human interrupt is not a failure: it is reported upward so the worker
      // can record the state the human asked for. It must never be turned into
      // NEEDS_HUMAN by the generic error path below.
      if (isTaskInterrupt(error)) {
        log.info("run.interrupted", {
          intent: error.request.intent,
          reason: error.request.reason,
        });
        // Close the run row before unwinding. Without this the row stays RUNNING
        // and stale detection would later report a run that was deliberately
        // stopped as abandoned.
        await this.hooks.onAborted?.({
          intent: error.request.intent,
          reason: error.request.reason,
        });
        throw error;
      }

      const message = error instanceof Error ? scrubSecrets(error.message) : String(error);
      log.error("run.error", { error: message });
      record.notes.push(`Orchestration error: ${message}`);
      
      let reason: StopReason = "INVALID_AGENT_OUTPUT";
      if (error instanceof BudgetExceededError) {
        reason = "BUDGET_EXCEEDED";
      }
      
      if (record.state !== "DONE" && record.state !== "NEEDS_HUMAN") {
        await this.stopByPolicy(record, reason, log, [message]);
      }
      await this.hooks.onFailed?.({ stopReason: reason, message });
    }

    return await this.finish(record, log);
  }

  // -------------------------------------------------------------------------
  // Agent invocation
  // -------------------------------------------------------------------------

  private async runCoder(params: {
    record: TaskRecord;
    agent: Agent;
    workspace: Workspace;
    cycle: number;
    reason: "INITIAL" | "FIX";
    task: TaskSpec;
    previousReview?: ReviewerOutput;
    log: Logger;
  }): Promise<CoderOutput> {
    const { record, agent, workspace, cycle, reason, task, previousReview, log } = params;
    const maxAttempts = this.config.orchestrator.maxAgentAttempts;
    let lastOutput: CoderOutput | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const input: AgentInput = {
        task,
        workspacePath: workspace.root,
        cycle,
        attempt,
        reason,
        ...(previousReview ? { previousReview } : {}),
        // Cooperative stop: the coder checks this between turns and before each
        // tool call, so a pause never leaves a tool call in flight.
        ...(this.checkInterrupt ? { guard: () => this.assertProceed(record, log) } : {}),
      };

      const startedAt = Date.now();
      try {
        const raw = await agent.execute(input);
        const output = isCoderOutput(raw) ? raw : synthesizeCoderFailure(raw, cycle);
        this.recordAttempt(record, {
          attempt,
          kind: "CODER",
          cycle,
          startedAt,
          ok: output.contractParsed !== false,
          usage: output.usage,
          resolvedModel: output.resolvedModel,
          ...(output.error ? { error: output.error } : {}),
        });
        lastOutput = output;

        if (output.contractParsed !== false) return output;

        this.logger.warn("coder.unparsable", {
          taskId: task.id,
          cycle,
          attempt,
          maxAttempts,
          error: output.error ?? "no parsable contract",
        });
      } catch (error) {
        // Never swallow a human interrupt as an agent failure.
        if (isTaskInterrupt(error)) throw error;
        
        const routerErr = toRouterError(error);
        const message = scrubSecrets(routerErr.message);

        this.recordAttempt(record, {
          attempt,
          kind: "CODER",
          cycle,
          startedAt,
          ok: false,
          error: message,
        });
        this.logger.warn("coder.call_failed", { taskId: task.id, cycle, attempt, error: message });
        lastOutput = synthesizeCoderThrow(message, cycle);

        if (!routerErr.retryable) {
          this.logger.warn("coder.fatal_error", { taskId: task.id, cycle, attempt, error: message });
          break;
        }

        if (attempt < maxAttempts) {
          const baseDelayMs = Math.pow(2, attempt) * 1000;
          const jitterMs = Math.random() * 1000;
          await new Promise(resolve => setTimeout(resolve, baseDelayMs + jitterMs));
        }
      }
    }

    return lastOutput ?? synthesizeCoderFailure({ ...emptyAgentOutput("coder") }, cycle);
  }

  private async runReviewer(params: {
    record: TaskRecord;
    agent: Agent;
    workspace: Workspace;
    cycle: number;
    task: TaskSpec;
    coderOutput: CoderOutput;
    log: Logger;
  }): Promise<ReviewerOutput> {
    const { record, agent, workspace, cycle, task, coderOutput, log } = params;
    const maxAttempts = this.config.orchestrator.maxAgentAttempts;
    let lastOutput: ReviewerOutput | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const input: AgentInput = {
        task,
        workspacePath: workspace.root,
        cycle,
        attempt,
        reason: cycle > 1 ? "FIX" : "INITIAL",
        previousCoder: coderOutput,
        ...(coderOutput.executed_commands ? { previousExecutions: coderOutput.executed_commands } : {}),
        ...(this.checkInterrupt ? { guard: () => this.assertProceed(record, log) } : {}),
      };

      const startedAt = Date.now();
      try {
        const raw = await agent.execute(input);
        const output = isReviewerOutput(raw) ? raw : synthesizeReviewerFailure(raw, cycle);
        this.recordAttempt(record, {
          attempt,
          kind: "REVIEWER",
          cycle,
          startedAt,
          ok: output.contractParsed !== false,
          usage: output.usage,
          resolvedModel: output.resolvedModel,
          ...(output.error && output.contractParsed === false ? { error: output.error } : {}),
        });
        lastOutput = output;

        if (output.contractParsed !== false) return output;

        this.logger.warn("reviewer.unparsable", {
          taskId: task.id,
          cycle,
          attempt,
          maxAttempts,
          error: output.error ?? "no parsable verdict",
        });
      } catch (error) {
        // Never swallow a human interrupt as a reviewer failure.
        if (isTaskInterrupt(error)) throw error;

        const routerErr = toRouterError(error);
        const message = scrubSecrets(routerErr.message);

        this.recordAttempt(record, {
          attempt,
          kind: "REVIEWER",
          cycle,
          startedAt,
          ok: false,
          error: message,
        });
        this.logger.warn("reviewer.call_failed", { taskId: task.id, cycle, attempt, error: message });
        lastOutput = synthesizeReviewerThrow(message, cycle);

        if (!routerErr.retryable) {
          this.logger.warn("reviewer.fatal_error", { taskId: task.id, cycle, attempt, error: message });
          break;
        }

        if (attempt < maxAttempts) {
          const baseDelayMs = Math.pow(2, attempt) * 1000;
          const jitterMs = Math.random() * 1000;
          await new Promise(resolve => setTimeout(resolve, baseDelayMs + jitterMs));
        }
      }
    }

    return lastOutput ?? synthesizeReviewerThrow("no reviewer output", cycle);
  }

  /**
   * A failed *call* (never a parsable answer) is an infrastructure problem, not
   * a verdict. A coder that honestly reports BLOCKED is NOT an infrastructure
   * failure — the reviewer gets to judge it.
   */
  private isInfrastructureFailure(output: CoderOutput | ReviewerOutput): boolean {
    return output.contractParsed === false && Boolean(output.error);
  }

  // -------------------------------------------------------------------------
  // TESTING state
  // -------------------------------------------------------------------------

  /**
   * The orchestrator does not re-run the test suite (the coder ran it inside the
   * sandbox and every exit code is recorded). What it does here is fail-safe
   * assessment: it reads the *verified* execution record and states plainly
   * whether any test-class command ran and whether all of them exited 0. The
   * result is logged and handed to the reviewer as evidence.
   */
  private assessTesting(record: TaskRecord, cycle: number, coder: CoderOutput, log: Logger): void {
    const commands = coder.executed_commands ?? [];
    const testCommands = coder.tests_run;
    const assessment: TestAssessment = {
      testsExecuted: testCommands.length > 0,
      allCommandsPassed: commands.length > 0 && commands.every((c) => c.exitCode === 0 && !c.timedOut),
      commandCount: commands.length,
      reason: "",
    };

    assessment.reason = !assessment.testsExecuted
      ? "No test-class command was executed by the coder; 'tests passed' cannot be verified."
      : assessment.allCommandsPassed
        ? "All recorded commands exited 0."
        : "At least one recorded command exited non-zero or timed out.";

    const entry = this.ensureCycle(record, cycle);
    entry.testing = assessment;

    log.info("testing.assessed", {
      cycle,
      testsExecuted: assessment.testsExecuted,
      allCommandsPassed: assessment.allCommandsPassed,
      commands: assessment.commandCount,
      coderTestsPassed: coder.tests_passed,
    });

    if (!assessment.testsExecuted) {
      record.notes.push(`Cycle ${cycle}: ${assessment.reason}`);
    }
  }

  // -------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------

  private checkBudgets(record: TaskRecord, log: Logger): StopReason | undefined {
    let totalTokens = 0;
    let coderTokens = 0;
    let reviewerTokens = 0;
    let toolTurns = 0;

    for (const attempt of record.attempts) {
      const usage = attempt.usage;
      if (usage) {
        totalTokens += usage.totalTokens;
        if (attempt.kind === "CODER") coderTokens += usage.totalTokens;
        if (attempt.kind === "REVIEWER") reviewerTokens += usage.totalTokens;
      }
      if (attempt.kind === "CODER" && attempt.ok) {
        toolTurns += 1;
      }
    }

    const limits = this.config.orchestrator;

    if (limits.maxTaskTokens && totalTokens > limits.maxTaskTokens) {
      log.warn("budget.exceeded", { reason: "maxTaskTokens", usage: totalTokens, limit: limits.maxTaskTokens });
      return "BUDGET_EXCEEDED";
    }
    if (limits.maxCoderTokens && coderTokens > limits.maxCoderTokens) {
      log.warn("budget.exceeded", { reason: "maxCoderTokens", usage: coderTokens, limit: limits.maxCoderTokens });
      return "BUDGET_EXCEEDED";
    }
    if (limits.maxReviewerTokens && reviewerTokens > limits.maxReviewerTokens) {
      log.warn("budget.exceeded", { reason: "maxReviewerTokens", usage: reviewerTokens, limit: limits.maxReviewerTokens });
      return "BUDGET_EXCEEDED";
    }
    if (limits.maxToolTurns && toolTurns > limits.maxToolTurns) {
      log.warn("budget.exceeded", { reason: "maxToolTurns", usage: toolTurns, limit: limits.maxToolTurns });
      return "BUDGET_EXCEEDED";
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Bookkeeping helpers
  // -------------------------------------------------------------------------

  private async transition(record: TaskRecord, to: TaskState, log: Logger): Promise<void> {
    assertTransition(record.state, to);
    const from = record.state;
    record.state = to;
    record.history.push(to);
    log.info("state.transition", { from, to, reviewCycles: record.reviewCycles });

    // Persist + publish. Ordering matters for the event stream, so it is awaited.
    await this.hooks.onStateChanged?.({ from, to, cycle: record.reviewCycles });
  }

  /** Records a terminal state reached by policy, not by a state-machine edge. */
  private async stopByPolicy(
    record: TaskRecord,
    reason: StopReason,
    log: Logger,
    notes: string[],
  ): Promise<void> {
    const from = record.state;
    const terminal = reachableTerminal(from);
    this.stop(record, reason, log, notes);
    await this.hooks.onStateChanged?.({
      from,
      to: terminal ?? record.state,
      cycle: record.reviewCycles,
      reason,
      policyStop: true,
    });
  }

  /** Records a terminal state reached by policy rather than by an edge. */
  private stop(record: TaskRecord, reason: StopReason, log: Logger, notes: string[]): void {
    const terminal = reachableTerminal(record.state);
    if (!terminal) {
      throw new Error(
        `Cannot stop: state ${record.state} has no terminal state (already terminal?)`,
      );
    }
    record.stopReason = reason;
    record.notes.push(...notes);
    const from = record.state;
    record.state = terminal;
    if (!record.history.includes(terminal)) record.history.push(terminal);
    log.warn("state.stop", { from, to: terminal, reason, notes });
  }

  private recordAttempt(
    record: TaskRecord,
    params: {
      attempt: number;
      kind: AgentAttempt["kind"];
      cycle: number;
      startedAt: number;
      ok: boolean;
      error?: string;
      usage?: AgentAttempt["usage"];
      resolvedModel?: string;
    },
  ): void {
    const finishedAt = Date.now();
    record.attempts.push({
      attempt: params.attempt,
      kind: params.kind,
      cycle: params.cycle,
      startedAt: this.isoFromMs(params.startedAt),
      finishedAt: this.isoFromMs(finishedAt),
      durationMs: finishedAt - params.startedAt,
      ok: params.ok,
      ...(params.error ? { error: params.error } : {}),
      ...(params.usage ? { usage: params.usage } : {}),
      ...(params.resolvedModel ? { resolvedModel: params.resolvedModel } : {}),
    });
  }

  private ensureCycle(record: TaskRecord, cycle: number): CycleRecord {
    let entry = record.cycles.find((candidate) => candidate.cycle === cycle);
    if (!entry) {
      entry = { cycle };
      record.cycles.push(entry);
      record.cycles.sort((a, b) => a.cycle - b.cycle);
    }
    return entry;
  }

  private async finish(record: TaskRecord, log: Logger): Promise<TaskRecord> {
    record.finishedAt = this.nowIso();
    const coderCalls = record.attempts.filter((a) => a.kind === "CODER").length;
    const reviewerCalls = record.attempts.filter((a) => a.kind === "REVIEWER").length;
    const totalTokens = record.attempts.reduce((sum, a) => sum + (a.usage?.totalTokens ?? 0), 0);

    log.info("run.finish", {
      state: record.state,
      approved: record.approved,
      stopReason: record.stopReason,
      reviewCycles: record.reviewCycles,
      coderCalls,
      reviewerCalls,
    });

    await this.hooks.onCompleted?.({
      state: record.state,
      approved: record.approved,
      reviewCycles: record.reviewCycles,
      ...(record.stopReason ? { stopReason: record.stopReason } : {}),
      coderCalls,
      reviewerCalls,
      totalTokens,
      durationMs: Date.parse(record.finishedAt) - Date.parse(record.startedAt),
    });

    return record;
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private isoFromMs(ms: number): string {
    return new Date(ms).toISOString();
  }
}

// ---------------------------------------------------------------------------
// Fallback contracts
// ---------------------------------------------------------------------------

/** The minimal shape the fallback builders read off an unusable output. */
interface UnusableOutput {
  agentId: string;
  usage?: AgentAttempt["usage"];
  resolvedModel?: string;
  raw?: string;
}

function emptyAgentOutput(role: string): UnusableOutput {
  return { agentId: role };
}

function synthesizeCoderFailure(raw: UnusableOutput, cycle: number): CoderOutput {
  return {
    agentId: raw.agentId,
    role: "coder",
    ok: false,
    contractParsed: false,
    status: "BLOCKED",
    summary: "Coder returned an unusable result object.",
    files_changed: [],
    tests_run: [],
    tests_passed: false,
    issues: [`Cycle ${cycle}: the coder output did not match the required contract.`],
    notes: "Synthesised by the orchestrator because the agent output was unusable.",
    ...(raw.usage ? { usage: raw.usage } : {}),
    ...(raw.resolvedModel ? { resolvedModel: raw.resolvedModel } : {}),
    ...(raw.raw ? { raw: raw.raw } : {}),
  };
}

function synthesizeCoderThrow(message: string, cycle: number): CoderOutput {
  return {
    agentId: "coder",
    role: "coder",
    ok: false,
    contractParsed: false,
    error: message,
    status: "BLOCKED",
    summary: `Coder call failed: ${message}`,
    files_changed: [],
    tests_run: [],
    tests_passed: false,
    issues: [`Cycle ${cycle}: ${message}`],
    notes: "Synthesised by the orchestrator after a coder call failure.",
  };
}

function synthesizeReviewerFailure(raw: UnusableOutput, cycle: number): ReviewerOutput {
  return {
    agentId: raw.agentId,
    role: "reviewer",
    ok: true,
    contractParsed: false,
    verdict: "REJECTED",
    summary: `[harness] Cycle ${cycle}: the reviewer output did not match the contract.`,
    issues: ["The reviewer did not return a parsable verdict."],
    required_fixes: [],
    severity: "HIGH",
    ...(raw.usage ? { usage: raw.usage } : {}),
    ...(raw.resolvedModel ? { resolvedModel: raw.resolvedModel } : {}),
  };
}

function synthesizeReviewerThrow(message: string, cycle: number): ReviewerOutput {
  return {
    agentId: "reviewer",
    role: "reviewer",
    ok: false,
    contractParsed: false,
    error: message,
    verdict: "REJECTED",
    summary: `[harness] Reviewer call failed: ${message}`,
    issues: [`Cycle ${cycle}: ${message}`],
    required_fixes: [],
    severity: "HIGH",
  };
}

/** Re-exported for convenience in tests and reports. */
export type { TaskState };
