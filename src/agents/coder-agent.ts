/**
 * CoderAgent — implements the `Agent` interface.
 *
 * It runs a real tool-calling loop against a `ModelProvider`:
 *
 *   model response → detect tool calls → execute them against the real
 *   workspace/process → append results → call the model again → repeat until a
 *   final contract is produced (or turns run out).
 *
 * Two layers make this robust, both driven by an observed production failure
 * (DeepSeek V4.1 Flash stopped after turn 1 without a single tool call, because
 * its XML tool call was mistaken for a final answer):
 *
 *   1. NATIVE tool calling. Tools are sent as OpenAI `tools` definitions and the
 *      model's `tool_calls` are executed directly. Verified working on 9Router
 *      (finish_reason "tool_calls" for both configured models).
 *   2. TEXT tool-call recovery. If a model emits its call as text (XML or a
 *      fenced/bare JSON object) instead of via the native channel, it is parsed
 *      and executed anyway. Text is never mistaken for completed work.
 *
 * Anti-fake-claim mechanism (the point of the whole design): the harness records
 * every file write and every command exit code itself, then OVERWRITES the
 * model's `files_changed`, `tests_run` and `tests_passed` with the verified
 * truth. A coder that reports green tests without running them cannot pass.
 *
 * Completion guard: a run that performed no work at all cannot report success.
 * `status: DONE` is refused when the model never touched a tool (and, for a task
 * that requires it, never executed a test), regardless of what it claims.
 */

import type {
  Agent,
  AgentInput,
  CoderOutput,
  CoderStatus,
  TokenUsage,
} from "../domain/types.js";
import { scrubSecrets, toRouterError, truncate } from "../domain/errors.js";
import { isTaskInterrupt } from "../domain/control.js";
import type { Logger } from "../domain/logger.js";
import {
  buildToolCallId,
  nullAgentObserver,
  type AgentObserver,
} from "./agent-observer.js";
import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "../providers/model-provider.js";
import {
  addUsage,
  asStringArray,
  emptyUsage,
  extractJsonObject,
  nativeToolCallToToolCall,
  parseToolCalls,
  type ToolCall,
} from "./base-agent.js";
import { compactContext } from "./compaction.js";
import {
  CODER_BLOCKED_INSTRUCTION,
  CODER_FINALISE_INSTRUCTION,
  CODER_FIX_INSTRUCTION,
  CODER_INITIAL_INSTRUCTION,
  buildTaskBrief,
  coderSystemPrompt,
} from "./prompts.js";
import {
  CommandRunner,
  createCoderTools,
  toolsAsJsonSchema,
  type ToolDefinition,
  type ToolExecutionMeta,
} from "./tools.js";
import { Workspace, snapshotWorkspace, type FileChange } from "./workspace.js";

export interface CoderAgentOptions {
  provider: ModelProvider;
  model: string;
  workspace: Workspace;
  logger: Logger;
  id?: string;
  /** Override the default tool set (used by tests with a scripted model). */
  tools?: ToolDefinition[];
  runner?: CommandRunner;
  /** Maximum tool-calling turns before the harness forces a final answer. */
  maxToolTurns?: number;
  maxTokens?: number;
  temperature?: number;
  /** When false, the model's self-reported fields are trusted (never in prod). */
  verifyClaims?: boolean;
  /**
   * Instrumentation sink. The agent reports what it does; the observer turns
   * that into events. Absent by default, so the agent has no dependency on the
   * event bus or the database.
   */
  observer?: AgentObserver;
  /** Threshold at which context compaction kicks in to save tokens */
  contextCompactionEnabled?: boolean;
  contextCompactionRatio?: number;
  modelContextWindow?: number;
}

interface ExecutedCommand {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  /** Which turn produced it. */
  turn: number;
}

interface VerifiedFacts {
  files: FileChange[];
  commands: ExecutedCommand[];
  /** Successful tool invocations, by name. */
  toolCallsByName: Record<string, number>;
  /** Total tool calls the harness actually executed. */
  toolExecutions: number;
  /** Tool call names the model invented (not in the registry). */
  unknownTools: string[];
}

function emptyFacts(): VerifiedFacts {
  return { files: [], commands: [], toolCallsByName: {}, toolExecutions: 0, unknownTools: [] };
}

/** Commands that count as "running the tests" for tests_run/tests_passed. */
const TEST_COMMAND_PATTERN =
  /\b(test|tests|vitest|jest|mocha|pytest|playwright|cypress|typecheck|tsc|build|lint|npm run|pnpm|yarn)\b/i;

export class CoderAgent implements Agent {
  readonly id: string;
  readonly role = "coder" as const;

  private readonly provider: ModelProvider;
  private readonly model: string;
  private readonly workspace: Workspace;
  private readonly logger: Logger;
  private readonly tools: ToolDefinition[];
  private readonly toolSpecs: ReturnType<typeof toolsAsJsonSchema>;
  private readonly maxToolTurns: number;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly verifyClaims: boolean;
  private readonly observer: AgentObserver;
  private readonly contextCompactionEnabled: boolean;
  private readonly contextCompactionRatio: number;
  private readonly modelContextWindow: number;

  constructor(options: CoderAgentOptions) {
    this.id = options.id ?? "coder-agent";
    this.provider = options.provider;
    this.model = options.model;
    this.workspace = options.workspace;
    this.logger = options.logger;
    this.maxToolTurns = options.maxToolTurns ?? 16;
    this.maxTokens = options.maxTokens ?? 8_192;
    this.temperature = options.temperature ?? 0.1;
    this.verifyClaims = options.verifyClaims ?? true;
    this.observer = options.observer ?? nullAgentObserver;
    this.tools =
      options.tools ??
      createCoderTools(this.workspace, options.runner ?? new CommandRunner());
    this.toolSpecs = toolsAsJsonSchema(this.tools);
    this.contextCompactionEnabled = options.contextCompactionEnabled ?? false;
    this.contextCompactionRatio = options.contextCompactionRatio ?? 0.75;
    this.modelContextWindow = options.modelContextWindow ?? 128_000;
  }

  async execute(input: AgentInput): Promise<CoderOutput> {
    const log = this.logger.child({
      agent: this.role,
      agentId: this.id,
      taskId: input.task.id,
      cycle: input.cycle,
      reason: input.reason,
      model: this.model,
    });

    const baseline = await snapshotWorkspace(this.workspace);
    const facts = emptyFacts();
    let usage = emptyUsage();
    let resolvedModel: string | undefined;
    let totalLatencyMs = 0;
    let lastText = "";
    let toolTurns = 0;

    const messages: ModelMessage[] = [
      { role: "system", content: coderSystemPrompt(this.tools) },
      {
        role: "user",
        content: `${buildTaskBrief(input)}\n\n${
          input.reason === "FIX" ? CODER_FIX_INSTRUCTION : CODER_INITIAL_INSTRUCTION
        }`,
      },
    ];

    log.info("agent.start", {
      tools: this.tools.length,
      maxToolTurns: this.maxToolTurns,
      nativeTools: this.toolSpecs.length,
    });

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

    let actualContextWindow = this.modelContextWindow;
    if (this.contextCompactionEnabled && this.provider.getModelMetadata) {
      try {
        const meta = await this.provider.getModelMetadata(this.model);
        if (meta?.contextWindow) actualContextWindow = meta.contextWindow;
      } catch (err) {
        log.warn("agent.metadata_error", { error: String(err) });
      }
    }

    try {
      // turn 1..maxToolTurns = working turns; the final iteration is the
      // forced-answer turn where tools are disabled.
      for (let turn = 1; turn <= this.maxToolTurns + 1; turn++) {
        // Safe point: a human pause/cancel stops the agent before another model
        // turn is issued.
        console.log(`[CODER] About to call guard for turn`, turn);
        input.guard?.();
        console.log(`[CODER] Guard passed for turn`, turn);
        const forcingFinalAnswer = turn > this.maxToolTurns;

        if (forcingFinalAnswer) {
          messages.push({
            role: "user",
            content: toolTurns > 0 ? CODER_FINALISE_INSTRUCTION : CODER_BLOCKED_INSTRUCTION,
          });
        }

        const rawMessages = messages;
        const compactedMessages = this.contextCompactionEnabled 
          ? compactContext(messages, {
              enabled: this.contextCompactionEnabled,
              ratio: this.contextCompactionRatio,
              contextWindow: actualContextWindow,
            })
          : messages;

        const request: ModelRequest = {
          model: this.model,
          messages: compactedMessages,
          temperature: this.temperature,
          maxTokens: this.maxTokens,
          requestId: `${input.task.id}-c${input.cycle}-coder-t${turn}`,
          // The schema stays visible so the model can shape a final answer, but
          // the forced turn explicitly forbids further tool calls.
          tools: this.toolSpecs,
          toolChoice: forcingFinalAnswer ? "none" : "auto",
        };

        const response = await this.provider.chat(request);
        usage = addUsage(usage, response.usage);
        resolvedModel = response.resolvedModel;
        lastText = response.content;
        totalLatencyMs += response.latencyMs;

        // The forced-answer turn tolerates no more work: whatever the model
        // said is the final word (tools were offered with tool_choice "none").
        if (forcingFinalAnswer) {
          log.info("agent.forced_final", {
            turn,
            chars: response.content.length,
            toolTurns,
          });
          break;
        }

        const turn_ = this.resolveTurn(response);

        log.info("agent.model_response", {
          turn,
          finishReason: response.finishReason,
          chars: response.content.length,
          nativeToolCalls: response.toolCalls?.length ?? 0,
          validToolCalls: turn_.valid.length,
          malformedToolCalls: turn_.malformed.length,
          toolSources: turn_.valid.map((call) => call.source).join(",") || "-",
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          cachedTokens: response.usage.cachedTokens,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          latencyMs: response.latencyMs,
        });
        log.debug("agent.model_content", { turn, content: truncate(response.content, 800) });

        if (turn_.valid.length === 0 && turn_.malformed.length === 0) {
          // The model produced a final answer (or nothing at all).
          if (response.content.trim() === "" && turn <= this.maxToolTurns) {
            // An empty turn is not an answer; nudge once and continue.
            log.warn("agent.empty_turn", { turn });
            messages.push({ role: "user", content: CODER_INITIAL_INSTRUCTION });
            continue;
          }
          break;
        }

        // --- execute the turn and append the results -----------------------
        messages.push(
          ...(await this.buildToolTurn(response, turn_, turn, facts, log, {
            taskId: input.task.id,
            cycle: input.cycle,
            ...(input.guard ? { guard: input.guard } : {}),
          })),
        );
        toolTurns += 1;
      }

      const output = this.buildOutput({
        input,
        parsed: extractJsonObject(lastText),
        facts,
        usage,
        raw: lastText,
        phase: this.classifyPhase(facts),
        ...(resolvedModel ? { resolvedModel } : {}),
      });

      log.info("agent.done", {
        status: output.status,
        ok: output.ok,
        toolExecutions: facts.toolExecutions,
        filesChanged: output.files_changed.length,
        commands: facts.commands.length,
        testsPassed: output.tests_passed,
        issues: output.issues.length,
      });

      await this.emitTestResults(input, facts);

      await this.observer.onAgentFinished({
        agentId: this.id,
        role: this.role,
        taskId: input.task.id,
        cycle: input.cycle,
        ok: output.ok,
        durationMs: Date.now() - startedAtMs,
        ...(resolvedModel ? { resolvedModel } : {}),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: totalLatencyMs,
      });

      return output;
    } catch (error) {
      if (isTaskInterrupt(error)) throw error;

      // Normalise regardless of whether the provider already did: an agent must
      // not assume its provider conforms to the error taxonomy.
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
        status: "BLOCKED",
        summary: `Coder failed before completing the task: ${message}`,
        files_changed: facts.files.map((file) => file.path),
        tests_run: facts.commands
          .filter((command) => TEST_COMMAND_PATTERN.test(command.command))
          .map((command) => command.command),
        tests_passed: false,
        issues: [message],
        notes: "The coder agent threw; no work was verified.",
        error: message,
        executed_commands: facts.commands,
        usage,
        ...(resolvedModel ? { resolvedModel } : {}),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Tool-call resolution and execution
  // -------------------------------------------------------------------------

  /**
   * Splits a turn into usable and malformed tool calls.
   *
   * Malformed calls are NOT dropped: the model must receive a real error so it
   * can correct itself, otherwise a bad argument silently ends the task.
   */
  private resolveTurn(response: ModelResponse): {
    valid: ToolCall[];
    malformed: ModelToolCall[];
  } {
    const native = response.toolCalls ?? [];
    if (native.length > 0) {
      const valid: ToolCall[] = [];
      const malformed: ModelToolCall[] = [];
      for (const call of native) {
        const resolved = nativeToolCallToToolCall(call);
        if (resolved) valid.push(resolved);
        else malformed.push(call);
      }
      // Nothing usable natively: a text-shaped call may still be present.
      if (valid.length === 0 && malformed.length > 0) {
        const fromText = parseToolCalls(response.content);
        if (fromText.length > 0) return { valid: fromText, malformed: [] };
      }
      return { valid, malformed };
    }

    // No native channel used — try text (XML / fenced JSON / Hermes).
    return { valid: parseToolCalls(response.content), malformed: [] };
  }

  /**
   * Executes the turn's tool calls and returns the messages to append.
   *
   * Native calls are echoed in the exact wire shape (each must be answered by a
   * `role: "tool"` message keyed on its id). Text-recovered calls carry a
   * synthetic id so the transcript stays coherent.
   */
  private async buildToolTurn(
    response: ModelResponse,
    turn_: { valid: ToolCall[]; malformed: ModelToolCall[] },
    turn: number,
    facts: VerifiedFacts,
    log: Logger,
    context: { taskId: string; cycle: number; guard?: () => void },
  ): Promise<ModelMessage[]> {
    const allNative = turn_.valid.every((call) => call.source === "native");

    if (allNative && turn_.malformed.length === 0) {
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: response.content,
          toolCalls: (response.toolCalls ?? []).filter((call) => !call.parseError),
        },
      ];
      const toolPromises = turn_.valid.map(async (call, index) => {
        // Safe point: stop before issuing another tool call.
        console.log(`[CODER] About to call guard for native tool`, call.tool);
        context.guard?.();
        console.log(`[CODER] Guard passed for native tool`, call.tool);
        const { text } = await this.executeToolCall(call, turn, facts, log, { ...context, index });
        return { role: "tool" as const, content: text, toolCallId: call.id, toolName: call.tool };
      });
      const results = await Promise.all(toolPromises);
      messages.push(...results);
      return messages;
    }

    // Text-recovered calls, or a native call whose arguments did not parse.
    const messages: ModelMessage[] = [
      { role: "assistant", content: this.transcriptContent(response.content, turn_.valid) },
    ];

    const toolPromises = turn_.valid.map(async (call, index) => {
      // Safe point: stop before issuing another tool call.
      console.log(`[CODER] About to call guard for tool`, call.tool);
      context.guard?.();
      console.log(`[CODER] Guard passed for tool`, call.tool);
      const { text } = await this.executeToolCall(call, turn, facts, log, { ...context, index });
      return { role: "tool" as const, content: text, toolCallId: call.id, toolName: call.tool };
    });
    
    const results = await Promise.all(toolPromises);
    messages.push(...results);

    for (const call of turn_.malformed) {
      const detail = call.parseError ?? "arguments could not be parsed";
      log.warn("tool.malformed", { tool: call.name, turn, detail });
      // Counted as a real attempt so a model that only emits garbage is not
      // mistaken for a model that did work.
      facts.toolExecutions += 1;
      messages.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content:
          `ERROR: could not parse the arguments for tool "${call.name}": ${detail}\n` +
          `Received: ${truncate(call.argumentsRaw || "(empty)", 300)}\n` +
          "Call the tool again with a valid JSON object of arguments.",
      });
    }

    return messages;
  }

  /** Content stored for the assistant turn; tool markup is removed. */
  private transcriptContent(content: string, calls: ToolCall[]): string {
    if (calls.every((call) => call.source === "native")) return content;
    let stripped = content;
    for (const call of calls) {
      stripped = stripped.replace(new RegExp(`<invoke\\s+name=["']${escapeRegex(call.tool)}["'][\\s\\S]*?<\\/invoke>`, "gi"), "");
    }
    stripped = stripped.replace(/<\/?tool_call>/gi, "");
    return truncate(stripped.trim(), 2_000);
  }

  private async executeToolCall(
    call: ToolCall,
    turn: number,
    facts: VerifiedFacts,
    log: Logger,
    context: { taskId: string; cycle: number; index: number },
  ): Promise<{ text: string; toolCallId?: string }> {
    const toolCallId = buildToolCallId({
      taskId: context.taskId,
      cycle: context.cycle,
      turn,
      index: context.index,
      ...(call.source === "native" ? { nativeId: call.id } : {}),
    });

    const observation = {
      agentId: this.id,
      role: this.role,
      taskId: context.taskId,
      cycle: context.cycle,
    } as const;

    const tool = this.tools.find((candidate) => candidate.name === call.tool);
    if (!tool) {
      facts.unknownTools.push(call.tool);
      log.warn("tool.unknown", { tool: call.tool, available: this.tools.map((t) => t.name) });

      // Unknown tools are still recorded, so a dashboard shows the model's
      // mistake rather than a silent gap.
      await this.observer.onToolStarted({ ...observation, toolCallId, tool: call.tool, arguments: call.args });
      await this.observer.onToolFinished({
        ...observation,
        toolCallId,
        tool: call.tool,
        success: false,
        durationMs: 0,
        outputSummary: `unknown tool; available: ${this.tools.map((t) => t.name).join(", ")}`,
      });

      return {
        text: `ERROR: unknown tool "${call.tool}". Available tools: ${this.tools
          .map((candidate) => candidate.name)
          .join(", ")}`,
        ...(call.source === "native" ? { toolCallId: call.id } : {}),
      };
    }

    const startedAt = Date.now();
    facts.toolExecutions += 1;
    facts.toolCallsByName[call.tool] = (facts.toolCallsByName[call.tool] ?? 0) + 1;

    await this.observer.onToolStarted({
      ...observation,
      toolCallId,
      tool: call.tool,
      arguments: call.args,
    });

    try {
      const result = await tool.handler(call.args);
      this.recordMeta(result.meta, facts, result.text, turn);
      const durationMs = Date.now() - startedAt;

      log.info("tool.result", {
        tool: call.tool,
        source: call.source,
        turn,
        durationMs,
        chars: result.text.length,
        command: result.meta?.command,
        exitCode: result.meta?.exitCode,
        path: result.meta?.path,
      });

      await this.observer.onToolFinished({
        ...observation,
        toolCallId,
        tool: call.tool,
        success: true,
        durationMs,
        outputSummary: result.text,
        exitCode: result.meta?.exitCode ?? null,
      });

      // A successful write is a file change worth showing on the dashboard.
      if (result.meta?.path) {
        await this.observer.onFileChanged({
          ...observation,
          path: result.meta.path,
          changeType: result.meta.action ?? "modified",
          summary: `${result.meta.action ?? "modified"} (${result.text.length} B reported)`,
        });
      }

      return {
        text: truncate(result.text, 2_000),
        ...(call.source === "native" ? { toolCallId: call.id } : {}),
      };
    } catch (error) {
      // A tool failure is data for the model, not a crash: hand it back so the
      // model can correct its arguments and retry.
      const message = error instanceof Error ? scrubSecrets(error.message) : String(error);
      log.warn("tool.error", { tool: call.tool, turn, error: message });

      await this.observer.onToolFinished({
        ...observation,
        toolCallId,
        tool: call.tool,
        success: false,
        durationMs: Date.now() - startedAt,
        outputSummary: message,
      });

      return {
        text: `ERROR: ${message}`,
        ...(call.source === "native" ? { toolCallId: call.id } : {}),
      };
    }
  }

  /**
   * Reports every test-class command that ran.
   *
   * Exactly one of them is flagged `authoritative` — the LAST one — which matches
   * the verification rule ("the final test run is the truth"). The database keeps
   * that under the reserved `final` key so recovery and the dashboard agree.
   */
  private async emitTestResults(input: AgentInput, facts: VerifiedFacts): Promise<void> {
    const tests = facts.commands.filter((command) => TEST_COMMAND_PATTERN.test(command.command));
    if (tests.length === 0) return;

    const lastIndex = tests.length - 1;
    for (const [index, test] of tests.entries()) {
      await this.observer.onTestFinished({
        agentId: this.id,
        role: this.role,
        taskId: input.task.id,
        cycle: input.cycle,
        command: test.command,
        exitCode: test.exitCode,
        passed: !test.timedOut && test.exitCode === 0,
        timedOut: test.timedOut,
        durationMs: 0,
        outputSummary: test.output,
        authoritative: index === lastIndex,
      });
    }
  }

  private recordMeta(
    meta: ToolExecutionMeta | undefined,
    facts: VerifiedFacts,
    text: string,
    turn: number,
  ): void {
    if (!meta) return;
    if (meta.path) {
      const existing = facts.files.find((file) => file.path === meta.path);
      if (existing) {
        existing.action =
          existing.action === "modified" ? "modified" : (meta.action ?? existing.action);
      } else {
        facts.files.push({ path: meta.path, action: meta.action ?? "modified", bytes: 0 });
      }
    }
    if (meta.command) {
      facts.commands.push({
        command: meta.command,
        exitCode: meta.exitCode ?? null,
        timedOut: meta.timedOut ?? false,
        output: truncate(text, 2_000),
        turn,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Contract assembly
  // -------------------------------------------------------------------------

  /**
   * What the harness actually observed. Used by the completion guard: a run is
   * only "completed" when real work happened.
   */
  private classifyPhase(facts: VerifiedFacts): "NO_TOOL_USE" | "NO_TEST_RUN" | "WORKED" {
    if (facts.toolExecutions === 0) return "NO_TOOL_USE";
    const tests = facts.commands.filter((command) => TEST_COMMAND_PATTERN.test(command.command));
    if (tests.length === 0) return "NO_TEST_RUN";
    return "WORKED";
  }

  private buildOutput(params: {
    input: AgentInput;
    parsed: unknown;
    facts: VerifiedFacts;
    usage: TokenUsage;
    raw: string;
    phase: "NO_TOOL_USE" | "NO_TEST_RUN" | "WORKED";
    resolvedModel?: string;
  }): CoderOutput {
    const { parsed, facts, usage, raw, phase } = params;
    const record = (parsed ?? {}) as Record<string, unknown>;
    const parsedOk = parsed !== undefined;

    const issues = asStringArray(record.issues);
    const notesFromModel = typeof record.notes === "string" ? record.notes : "";

    // ---- verified facts (authoritative) ----
    const verifiedFiles = facts.files.map((file) => file.path);
    const testCommands = facts.commands.filter((command) => TEST_COMMAND_PATTERN.test(command.command));
    const verifiedTestCommands = testCommands.map((command) => command.command);

    /**
     * The AUTHORITATIVE signal is the LAST test-class command.
     *
     * Requiring every historical command to have exited 0 is wrong: a real fix
     * cycle legitimately runs a failing test, fixes the code, and re-runs it.
     * This was observed in production — an exploratory compound command exited 9
     * before the real suite passed, which made the report contradict its own
     * APPROVED verdict.
     *
     * A timeout anywhere still fails the run: a hung test tells us nothing.
     */
    const lastTestCommand = testCommands.at(-1);
    const verifiedTestsPassed =
      lastTestCommand !== undefined &&
      !lastTestCommand.timedOut &&
      lastTestCommand.exitCode === 0 &&
      !testCommands.some((command) => command.timedOut);

    /** Test commands that exited non-zero along the way. Reported, not fatal. */
    const earlierFailedTests = testCommands.filter(
      (command) => command !== lastTestCommand && (command.exitCode !== 0 || command.timedOut),
    );

    // ---- model claims (advisory) ----
    const claimedFiles = asStringArray(record.files_changed);
    const claimedTestCommands = asStringArray(record.tests_run);
    const claimedTestsPassed = record.tests_passed === true;
    const requestedStatus: CoderStatus = record.status === "BLOCKED" ? "BLOCKED" : "DONE";

    if (!parsedOk) {
      issues.unshift(
        "The coder did not return a parsable JSON result object; status is reported as BLOCKED.",
      );
    }

    if (this.verifyClaims) {
      const unverified = claimedFiles.filter((file) => !verifiedFiles.includes(file));
      if (unverified.length > 0) {
        issues.push(
          `Claimed files_changed do not match the harness record: ${unverified.join(", ")}`,
        );
      }
      const unrunTests = claimedTestCommands.filter((command) => !verifiedTestCommands.includes(command));
      if (unrunTests.length > 0) {
        issues.push(`Claimed tests_run were never executed: ${unrunTests.join(", ")}`);
      }
      if (claimedTestsPassed && !verifiedTestsPassed) {
        issues.push(
          lastTestCommand === undefined
            ? "The coder reported tests_passed=true but executed no test command."
            : `The coder reported tests_passed=true but the final test command exited ${
                lastTestCommand.timedOut ? "via TIMEOUT" : String(lastTestCommand.exitCode)
              }.`,
        );
      }
    }

    // ---- completion guard -------------------------------------------------
    // Text is not work. A run that never used a tool cannot be DONE, no matter
    // what the model claims, and the same applies to a task that requires a test
    // run which never happened.
    let status: CoderStatus = parsedOk ? requestedStatus : "BLOCKED";

    if (this.verifyClaims) {
      if (phase === "NO_TOOL_USE") {
        // Always reported: this is the root cause, whether or not the model also
        // failed to emit a contract.
        issues.push(
          "The coder produced no tool calls at all: it described work instead of performing it, so the task was not attempted.",
        );
        status = "BLOCKED";
      } else if (phase === "NO_TEST_RUN") {
        issues.push(
          "The coder never executed a test command, so 'tests passed' is unverifiable. Implement the task and run the project's test command.",
        );
        if (status === "DONE") status = "BLOCKED";
      } else if (!verifiedTestsPassed) {
        // Work happened and tests ran, but the final run did not pass. The model
        // may not declare the task complete on a red suite.
        if (status === "DONE") {
          status = "BLOCKED";
          issues.push(
            "The coder reported DONE but the final test command did not pass, so the task is not verified as complete.",
          );
        }
      }
    }

    const notes = [
      notesFromModel,
      `HARNESS: executed ${facts.toolExecutions} tool call(s) across ${Object.keys(facts.toolCallsByName).length} distinct tool(s).`,
      `HARNESS: verified ${verifiedFiles.length} file write(s) and ${facts.commands.length} command(s).`,
      `HARNESS: phase=${phase}.`,
      `HARNESS: final test command -> ${
        lastTestCommand
          ? lastTestCommand.timedOut
            ? "TIMED OUT"
            : `exit ${lastTestCommand.exitCode}`
          : "none executed"
      }.`,
      ...(facts.unknownTools.length
        ? [`HARNESS: the model asked for unknown tool(s): ${facts.unknownTools.join(", ")}`]
        : []),
      ...(earlierFailedTests.length > 0
        ? [
            `HARNESS: ${earlierFailedTests.length} earlier test-class command(s) exited non-zero before the final run: ` +
              earlierFailedTests
                .map((command) => `[${command.exitCode ?? "null"}] ${truncate(command.command, 120)}`)
                .join(" ; "),
          ]
        : []),
      ...(testCommands.length === 0
        ? ["HARNESS: no test-class command was executed during this run."]
        : []),
    ]
      .filter((line) => line.trim().length > 0)
      .join("\n");

    return {
      agentId: this.id,
      role: this.role,
      ok: parsedOk && status === "DONE" && (this.verifyClaims ? verifiedTestsPassed : true),
      contractParsed: parsedOk,
      status,
      summary: typeof record.summary === "string" ? record.summary : "(no summary provided)",
      files_changed: this.verifyClaims
        ? verifiedFiles
        : claimedFiles.length
          ? claimedFiles
          : verifiedFiles,
      tests_run: this.verifyClaims
        ? verifiedTestCommands
        : claimedTestCommands.length
          ? claimedTestCommands
          : verifiedTestCommands,
      tests_passed: this.verifyClaims ? verifiedTestsPassed : claimedTestsPassed,
      issues,
      notes,
      executed_commands: facts.commands,
      raw: truncate(raw, 4_000),
      usage,
      ...(params.resolvedModel ? { resolvedModel: params.resolvedModel } : {}),
    };
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
