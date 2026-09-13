/**
 * ReviewerAgent — independent verifier.
 *
 * Structurally this agent has NO workspace and NO tools: it only receives text
 * evidence assembled by the harness from the real filesystem and the real
 * command log. Two properties follow:
 *   1. It cannot be tricked into "looking at" a file the coder described.
 *   2. A false claim (green tests that never ran) is visible, because the
 *      command log the harness produced is included verbatim.
 */

import type {
  Agent,
  AgentInput,
  AgentOutput,
  ReviewSeverity,
  ReviewerOutput,
  ReviewVerdict,
  TaskSpec,
  TokenUsage,
} from "../domain/types.js";
import { isTaskInterrupt } from "../domain/control.js";
import { scrubSecrets, toRouterError, truncate } from "../domain/errors.js";
import type { Logger } from "../domain/logger.js";
import type { ModelProvider } from "../providers/model-provider.js";
import { addUsage, asStringArray, emptyUsage, extractJsonObject } from "./base-agent.js";
import { buildTaskEvidence, renderEvidence } from "./evidence.js";
import { REVIEWER_SYSTEM_PROMPT, REVIEWER_USER_INSTRUCTION } from "./prompts.js";
import type { Workspace } from "./workspace.js";
import { nullAgentObserver, type AgentObserver } from "./agent-observer.js";

export interface ReviewerAgentOptions {
  provider: ModelProvider;
  model: string;
  /** Read-only: used solely to snapshot evidence for the prompt. */
  workspace: Workspace;
  logger: Logger;
  id?: string;
  /**
   * Prior coder attempts in this cycle that produced unparsable output. Passed
   * per-call through `renderPrompt`; kept here only for the default empty value.
   */
  maxTokens?: number;
  temperature?: number;
  /** Instrumentation sink; see CoderAgentOptions.observer. */
  observer?: AgentObserver;
}

const SEVERITIES: readonly ReviewSeverity[] = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

export class ReviewerAgent implements Agent {
  readonly id: string;
  readonly role = "reviewer" as const;

  private readonly provider: ModelProvider;
  private readonly model: string;
  private readonly workspace: Workspace;
  private readonly logger: Logger;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly observer: AgentObserver;

  constructor(options: ReviewerAgentOptions) {
    this.id = options.id ?? "reviewer-agent";
    this.provider = options.provider;
    this.model = options.model;
    this.workspace = options.workspace;
    this.logger = options.logger;
    this.maxTokens = options.maxTokens ?? 4_096;
    this.temperature = options.temperature ?? 0;
    this.observer = options.observer ?? nullAgentObserver;
  }

  async execute(input: AgentInput): Promise<ReviewerOutput> {
    const log = this.logger.child({
      agent: this.role,
      agentId: this.id,
      taskId: input.task.id,
      cycle: input.cycle,
      model: this.model,
    });

    log.info("agent.start", { hasPreviousReview: Boolean(input.previousReview) });

    const startedAtMs = Date.now();
    await this.observer.onAgentStarted({
      agentId: this.id,
      role: this.role,
      taskId: input.task.id,
      cycle: input.cycle,
      model: this.model,
      attempt: input.attempt ?? 1,
      runReason: input.reason,
    });

    const evidence = await this.buildEvidence(input);
    const prompt = this.renderPrompt(input, evidence);

    let usage = emptyUsage();
    let resolvedModel: string | undefined;
    let lastText = "";

    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const messages = [
          { role: "system" as const, content: REVIEWER_SYSTEM_PROMPT },
          {
            role: "user" as const,
            content:
              attempt === 1
                ? `${prompt}\n\n${REVIEWER_USER_INSTRUCTION}`
                : `${prompt}\n\nYour previous reply could not be parsed as JSON. Reply with ONLY the JSON review object, nothing else.`,
          },
        ];

        const response = await this.provider.chat({
          model: this.model,
          messages,
          temperature: this.temperature,
          maxTokens: this.maxTokens,
          json: true,
          requestId: `${input.task.id}-c${input.cycle}-reviewer-a${attempt}`,
        });

        usage = addUsage(usage, response.usage);
        resolvedModel = response.resolvedModel;
        lastText = response.content;

        log.info("agent.model_response", {
          attempt,
          finishReason: response.finishReason,
          chars: response.content.length,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          latencyMs: response.latencyMs,
        });

        const parsed = extractJsonObject(response.content);
        const output = this.buildOutput(parsed, lastText, usage, input.task, resolvedModel);
        if (output) {
          log.info("agent.done", {
            verdict: output.verdict,
            severity: output.severity,
            issues: output.issues.length,
            requiredFixes: output.required_fixes.length,
          });
          await this.observer.onAgentFinished({
            agentId: this.id,
            role: this.role,
            taskId: input.task.id,
            cycle: input.cycle,
            ok: output.contractParsed !== false,
            durationMs: Date.now() - startedAtMs,
            ...(output.resolvedModel ? { resolvedModel: output.resolvedModel } : {}),
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cachedTokens: usage.cachedTokens,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            latencyMs: response.latencyMs,
          });
          return output;
        }
      }

      log.error("agent.unparsable", { chars: lastText.length });
      await this.observer.onAgentFinished({
        agentId: this.id,
        role: this.role,
        taskId: input.task.id,
        cycle: input.cycle,
        ok: false,
        durationMs: Date.now() - startedAtMs,
        error: "unparsable reviewer output",
      });
      return fallbackReview(
        this.id,
        input.task,
        usage,
        resolvedModel,
        "The reviewer model did not return a parsable JSON verdict after 3 attempts.",
        lastText,
      );
    } catch (error) {
      if (isTaskInterrupt(error)) throw error;
      const message = toRouterError(error).message;
      log.error("agent.error", { error: message });
      await this.observer.onAgentFinished({
        agentId: this.id,
        role: this.role,
        taskId: input.task.id,
        cycle: input.cycle,
        ok: false,
        durationMs: Date.now() - startedAtMs,
        error: message,
      });
      return {
        agentId: this.id,
        role: this.role,
        ok: false,
        contractParsed: false,
        error: message,
        verdict: "REJECTED",
        summary: `Reviewer failed: ${message}`,
        issues: [`Reviewer infrastructure failure: ${message}`],
        required_fixes: [],
        severity: "HIGH",
        usage,
        ...(resolvedModel ? { resolvedModel } : {}),
        raw: truncate(lastText, 2_000),
      };
    }
  }

  private async buildEvidence(input: AgentInput) {
    const coder = input.previousCoder;
    // Executions can arrive either as a first-class input field (orchestrator)
    // or attached to the coder contract. Prefer the explicit one.
    const executions = input.previousExecutions ?? coder?.executed_commands;

    if (!coder) {
      // Without a coder contract there is still real material to verify: the
      // workspace itself. We reconstruct a minimal contract so the evidence
      // builder can include every file as "wanted".
      const files = await this.workspace.listFiles({ maxFiles: 5_000 });
      return buildTaskEvidence({
        workspace: this.workspace,
        task: input.task,
        cycle: input.cycle,
        attemptCount: 0,
        coder: {
          agentId: "unknown",
          role: "coder",
          ok: false,
          status: "BLOCKED",
          summary: "(no coder output was available for this cycle)",
          files_changed: files.map((f) => f.path),
          tests_run: [],
          tests_passed: false,
          issues: ["The coder produced no parsable output for this cycle."],
          notes: "",
        },
        ...(executions ? { executed: executions } : {}),
      });
    }

    return buildTaskEvidence({
      workspace: this.workspace,
      task: input.task,
      cycle: input.cycle,
      attemptCount: input.attempt ?? 1,
      coder,
      ...(executions ? { executed: executions } : {}),
    });
  }

  private renderPrompt(
    input: AgentInput,
    evidence: Awaited<ReturnType<typeof buildTaskEvidence>>,
  ): string {
    const parts = [renderEvidence(evidence)];

    const failedAttempts = input.previousCoder?.contractParsed === false ? 1 : 0;
    const priorFailures = failedAttempts > 0 ? ["the coder did not return a parsable result object"] : [];
    const coderHasNoRecordedCommands = (input.previousExecutions?.length ?? 0) === 0;

    if (priorFailures.length || coderHasNoRecordedCommands) {
      parts.push("", "RELIABILITY NOTES:");
      for (const failure of priorFailures) parts.push(`- ${failure}`);
      if (coderHasNoRecordedCommands) {
        parts.push("- no command execution was recorded for the coder run in this cycle");
      }
    }

    if (input.previousReview) {
      parts.push(
        "",
        `PREVIOUS REVIEW (cycle ${input.cycle - 1}, severity ${input.previousReview.severity}):`,
        `  summary: ${input.previousReview.summary}`,
        "  required fixes that were requested:",
        ...input.previousReview.required_fixes.map((fix) => `    - ${fix}`),
        "",
        "Check explicitly whether each required fix was actually implemented.",
      );
    }

    return parts.join("\n");
  }

  private buildOutput(
    parsed: unknown,
    raw: string,
    usage: TokenUsage,
    task: TaskSpec,
    resolvedModel?: string,
  ): ReviewerOutput | undefined {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;

    const verdictRaw = String(record.verdict ?? "").trim().toUpperCase();
    const verdict: ReviewVerdict | undefined =
      verdictRaw === "APPROVED" || verdictRaw === "REJECTED"
        ? (verdictRaw as ReviewVerdict)
        : undefined;

    const severityRaw = String(record.severity ?? "").trim().toUpperCase();
    const severity: ReviewSeverity = (SEVERITIES as readonly string[]).includes(severityRaw)
      ? (severityRaw as ReviewSeverity)
      : "MEDIUM";

    const issues = asStringArray(record.issues);
    const requiredFixes = asStringArray(record.required_fixes);
    const summary = typeof record.summary === "string" ? record.summary : "";

    // A verdict we cannot read is a rejected review: never approve by accident.
    if (!verdict) {
      return fallbackReview(
        this.id,
        task,
        usage,
        resolvedModel,
        "The reviewer returned an unreadable verdict; treated as REJECTED.",
        raw,
        issues,
      );
    }

    const output: ReviewerOutput = {
      agentId: this.id,
      role: this.role,
      ok: true,
      contractParsed: true,
      verdict,
      summary,
      issues,
      required_fixes: requiredFixes,
      severity,
      raw: truncate(raw, 4_000),
      usage,
      ...(resolvedModel ? { resolvedModel } : {}),
    };

    // Structural safety net: an APPROVED with blocking severity or outstanding
    // required fixes is self-contradictory, so it is downgraded to REJECTED.
    if (verdict === "APPROVED" && (severity === "HIGH" || severity === "CRITICAL")) {
      return {
        ...output,
        verdict: "REJECTED",
        summary: `${summary}\n[harness] Verdict downgraded to REJECTED: severity ${severity} contradicts APPROVED.`,
        required_fixes: requiredFixes.length
          ? requiredFixes
          : ["Resolve the HIGH/CRITICAL issues listed above."],
      };
    }
    if (verdict === "APPROVED" && requiredFixes.length > 0) {
      return {
        ...output,
        verdict: "REJECTED",
        summary: `${summary}\n[harness] Verdict downgraded to REJECTED: required_fixes was non-empty.`,
      };
    }

    return output;
  }
}

function fallbackReview(
  agentId: string,
  task: TaskSpec,
  usage: TokenUsage,
  resolvedModel: string | undefined,
  reason: string,
  raw: string,
  issues: string[] = [],
): ReviewerOutput {
  return {
    agentId,
    role: "reviewer",
    ok: true,
    contractParsed: false,
    verdict: "REJECTED",
    summary: `[harness] ${reason}`,
    issues: [...issues, reason],
    required_fixes: [],
    severity: "HIGH",
    raw: truncate(raw, 2_000),
    usage,
    ...(resolvedModel ? { resolvedModel } : {}),
    error: `unparsable reviewer output for ${task.id}`,
  };
}
