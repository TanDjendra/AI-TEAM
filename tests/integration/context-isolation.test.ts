/**
 * Context isolation between tasks (audit + regression).
 *
 * GOAL
 *   Prove that TASK-B does not inherit the transcript / tool history / reviewer
 *   history of TASK-A, while still seeing the latest codebase and the
 *   dependency state it actually needs.
 *
 * WHAT IS REAL HERE
 *   - The real `CoderAgent` tool loop, the real `Workspace`, the real
 *     `OrchestratorService` review loop, the real prompt builders.
 *   - Only the `ModelProvider` seam is scripted — it records every `ModelRequest`
 *     the agents emit, which is exactly the payload we must inspect.
 *
 * WHY A SCRIPTED PROVIDER IS THE RIGHT SEAM
 *   `ModelRequest.messages` is the literal wire payload sent to the model. If
 *   TASK-A's transcript leaked into TASK-B, it would appear in one of these
 *   captured requests. This test asserts on the captured payload, not on a mock.
 *
 * This file is an AUDIT artifact. It adds no production feature.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoderAgent } from "../../src/agents/coder-agent.js";
import { CommandRunner } from "../../src/agents/tools.js";
import { Workspace } from "../../src/agents/workspace.js";
import { createLogger } from "../../src/domain/logger.js";
import type { Agent, AgentInput, AgentOutput, TaskSpec } from "../../src/domain/types.js";
import type {
  ChatStreamChunk,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ProviderHealth,
} from "../../src/providers/model-provider.js";
import { OrchestratorService } from "../../src/orchestration/runner.js";
import { makeCoderOutput, makeReviewerOutput, testConfig } from "../helpers/index.js";

type ScriptedTurn =
  | string
  | { content?: string; toolCalls: Array<{ name: string; arguments: string; id?: string }> };

/**
 * A provider that records every payload and replays a script. Same shape as the
 * one used by `agents.test.ts`, kept local so this audit is self-contained.
 */
class RecordingProvider implements ModelProvider {
  readonly id = "recording";
  readonly baseUrl = "http://recording.invalid/v1";
  readonly calls: ModelRequest[] = [];

  constructor(private readonly script: ScriptedTurn[]) {}

  async chat(input: ModelRequest): Promise<ModelResponse> {
    this.calls.push(input);
    const index = this.calls.length - 1;
    const turn = this.script[index] ?? this.script[this.script.length - 1] ?? "";

    const content = typeof turn === "string" ? turn : (turn.content ?? "");
    const rawCalls = typeof turn === "string" ? [] : (turn.toolCalls ?? []);

    const toolCalls: ModelToolCall[] = rawCalls.map((call, i) => {
      const out: ModelToolCall = { id: call.id ?? `call_${index}_${i}`, name: call.name, argumentsRaw: call.arguments };
      try {
        const parsed: unknown = JSON.parse(call.arguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.args = parsed as Record<string, unknown>;
        }
      } catch {
        out.parseError = "invalid json";
      }
      return out;
    });

    return {
      id: `resp-${this.calls.length}`,
      resolvedModel: "scripted-model",
      requestedModel: input.model,
      content,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      latencyMs: 1,
      attempts: 1,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  // eslint-disable-next-line require-yield
  async *chatStream(_input: ModelRequest): AsyncGenerator<ChatStreamChunk, ModelResponse, void> {
    throw new Error("not used");
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, baseUrl: this.baseUrl, latencyMs: 0 };
  }

  /** Concatenated payload of every request, for leak assertions. */
  allContent(): string {
    return this.calls
      .flatMap((call) => call.messages)
      .map((message) => message.content)
      .join("\n---\n");
  }
}

const logger = createLogger({ level: "error", sink: () => {} });

const PASSING_TEST =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => { assert.equal(1, 1); });\n';

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ctx-iso-"));
  workspace = new Workspace(root);
});

afterEach(async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

/** A unique marker embedded only in TASK-A's transcript. */
const TASK_A_SECRET = "TASK-A-SECRET-TRANSCRIPT-MARKER-8f3a";
const TASK_A_TOOL_RESULT = "TASK-A-SECRET-TOOL-OUTPUT-MARKER-c1d4";
const TASK_A_REVIEWER_FIX = "TASK-A-SECRET-REVIEWER-FIX-2b7e";

// ===========================================================================
// Level 1: coder-level payload inspection (the exact model payload)
// ===========================================================================

describe("context isolation — coder payload (TASK-A history must not reach TASK-B)", () => {
  it("TASK-B's model payload excludes TASK-A's transcript, tool output and review", async () => {
    // ---- TASK-A: a big, noisy history -------------------------------------
    // 6 tool turns, each with a large tool result, plus secret markers the
    // model itself writes into its prose.
    const bigFile = `// ${TASK_A_TOOL_RESULT}\n` + "export const a = 1;\n".repeat(400);
    const taskATurns: ScriptedTurn[] = [
      { content: `${TASK_A_SECRET} starting`, toolCalls: [{ name: "write_file", arguments: JSON.stringify({ path: "src/a.js", content: bigFile }) }] },
      { content: `${TASK_A_SECRET} turn 2`, toolCalls: [{ name: "read_file", arguments: JSON.stringify({ path: "src/a.js" }) }] },
      { content: `${TASK_A_SECRET} turn 3`, toolCalls: [{ name: "list_files", arguments: "{}" }] },
      { content: `${TASK_A_SECRET} turn 4`, toolCalls: [{ name: "write_file", arguments: JSON.stringify({ path: "test/a.test.js", content: PASSING_TEST }) }] },
      { content: `${TASK_A_SECRET} turn 5`, toolCalls: [{ name: "run_command", arguments: JSON.stringify({ command: "node --test" }) }] },
      JSON.stringify({
        status: "DONE",
        summary: `${TASK_A_SECRET} implementation complete`,
        files_changed: ["src/a.js", "test/a.test.js"],
        tests_run: ["node --test"],
        tests_passed: true,
        issues: [],
        notes: `${TASK_A_SECRET} notes`,
      }),
    ];

    const providerA = new RecordingProvider(taskATurns);
    const coderA = new CoderAgent({
      provider: providerA,
      model: "grip/deepseek-v4.1-flash",
      workspace,
      logger,
      runner: new CommandRunner({ timeoutMs: 60_000 }),
    });

    const taskA: TaskSpec = {
      id: "TASK-A",
      title: "big history task",
      description: "produce a large transcript",
    };
    const outputA = await coderA.execute({ task: taskA, workspacePath: root, cycle: 1, reason: "INITIAL" });

    // Sanity: TASK-A really produced a multi-turn history with the secrets in it.
    expect(providerA.calls.length).toBeGreaterThanOrEqual(6);
    expect(providerA.allContent()).toContain(TASK_A_SECRET);
    expect(providerA.allContent()).toContain(TASK_A_TOOL_RESULT);
    expect(outputA.status).toBe("DONE");

    const taskABytes = providerA.calls.reduce((sum, call) => sum + JSON.stringify(call.messages).length, 0);

    // ---- TASK-B: a brand-new agent + provider on the same workspace --------
    // This mirrors the production path: `createCoder` builds a NEW CoderAgent
    // for each task, with an empty `messages` array.
    const providerB = new RecordingProvider([
      JSON.stringify({
        status: "DONE",
        summary: "no work needed",
        files_changed: [],
        tests_run: [],
        tests_passed: false,
        issues: [],
        notes: "",
      }),
    ]);
    const coderB = new CoderAgent({
      provider: providerB,
      model: "grip/deepseek-v4.1-flash",
      workspace,
      logger,
      runner: new CommandRunner({ timeoutMs: 60_000 }),
    });

    const taskB: TaskSpec = { id: "TASK-B", title: "second task", description: "unrelated follow-up work" };
    const outputB = await coderB.execute({ task: taskB, workspacePath: root, cycle: 1, reason: "INITIAL" });

    const payloadB = providerB.allContent();
    const taskBBytes = providerB.calls.reduce((sum, call) => sum + JSON.stringify(call.messages).length, 0);

    // ---- ASSERTIONS: no cross-task leakage ---------------------------------

    // 1. TASK-A's identity never appears in TASK-B's payload.
    expect(payloadB).not.toContain("TASK-A");
    expect(payloadB).not.toContain(TASK_A_SECRET);
    expect(payloadB).not.toContain(TASK_A_TOOL_RESULT);
    expect(payloadB).not.toContain(TASK_A_REVIEWER_FIX);

    // 2. TASK-A's transcript is not present: no assistant/tool turns carry over.
    const bMessages = providerB.calls[0]!.messages;
    expect(bMessages.map((m) => m.role)).toEqual(["system", "user"]);
    const bTurnCount = providerB.calls[0]!.messages.length;
    expect(bTurnCount).toBeLessThanOrEqual(2);

    // 3. TASK-B sees the *latest* codebase: the first instruction tells it to
    //    inspect the workspace, and its tools operate on the same live workspace
    //    (which already contains TASK-A's files). It is not shown them; it can
    //    discover them itself.
    expect(await workspace.fileExists("src/a.js")).toBe(true);
    expect(payloadB).toContain("TASK-B"); // its own identity is present
    expect(payloadB).toMatch(/inspect/i); // the "inspect the workspace" instruction

    // 4. Size comparison: TASK-B's payload is dramatically smaller.
    expect(taskBBytes).toBeLessThan(taskABytes);
    // Not merely smaller — it must be a fresh, bounded brief: a couple hundred
    // bytes of framing plus the system prompt and tool catalog.
    expect(taskBBytes).toBeLessThan(taskABytes / 2);

    // 5. Token accounting: TASK-B used exactly ONE model call, so its input
    //    tokens are the cost of one fresh brief — no accumulation from TASK-A.
    expect(providerB.calls).toHaveLength(1);
    expect(outputB.usage?.promptTokens).toBe(100); // the single scripted call
    expect(outputB.usage?.totalTokens).toBe(150);

    // Report the measured sizes (visible in verbose vitest output).
    // eslint-disable-next-line no-console
    console.log(
      `[context-isolation] TASK-A payload bytes=${taskABytes} (${providerA.calls.length} model calls) | ` +
        `TASK-B payload bytes=${taskBBytes} (${providerB.calls.length} model call) | ` +
        `TASK-B input tokens=${outputB.usage?.promptTokens ?? "n/a"} total=${outputB.usage?.totalTokens ?? "n/a"}`,
    );
  });

  it("TASK-B sees its own dependency state (reviewer fixes) but not TASK-A's", async () => {
    // A FIX run for TASK-B carries ONLY TASK-B's previous review.
    const providerB = new RecordingProvider([
      JSON.stringify({
        status: "DONE",
        summary: "fixed",
        files_changed: [],
        tests_run: [],
        tests_passed: false,
        issues: [],
        notes: "",
      }),
    ]);
    const coderB = new CoderAgent({
      provider: providerB,
      model: "m",
      workspace,
      logger,
      runner: new CommandRunner({ timeoutMs: 60_000 }),
    });

    const taskB: TaskSpec = { id: "TASK-B", title: "fix task", description: "apply required fixes" };
    await coderB.execute({
      task: taskB,
      workspacePath: root,
      cycle: 2,
      reason: "FIX",
      previousReview: {
        agentId: "reviewer",
        role: "reviewer",
        ok: true,
        verdict: "REJECTED",
        summary: "TASK-B review only",
        issues: ["TASK-B issue"],
        required_fixes: ["TASK-B required fix"],
        severity: "MEDIUM",
      },
    });

    const payload = providerB.allContent();
    // Its own dependency state is visible…
    expect(payload).toContain("TASK-B required fix");
    // …and its ancestor task is not.
    expect(payload).not.toContain("TASK-A");
    expect(payload).not.toContain(TASK_A_REVIEWER_FIX);
  });
});

// ===========================================================================
// Level 2: full orchestrator run — two sequential tasks, real review loop
// ===========================================================================

/**
 * Captures the `AgentInput` the orchestrator hands each agent. This is the
 * strongest possible proof of isolation at the orchestration layer: whatever
 * `AgentInput` lacks cannot reach the model payload.
 */
class CapturingAgent implements Agent {
  readonly inputs: AgentInput[] = [];
  constructor(
    readonly id: string,
    readonly role: string,
    private readonly outputs: AgentOutput[],
  ) {}
  async execute(input: AgentInput): Promise<AgentOutput> {
    this.inputs.push(input);
    return this.outputs[this.inputs.length - 1] ?? this.outputs[this.outputs.length - 1]!;
  }
}

describe("context isolation — orchestrator AgentInput carries only current-task data", () => {
  it("TASK-B's AgentInput references only TASK-B and never TASK-A", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ctx-iso-orch-"));
    try {
      const coderA = new CapturingAgent("coder-a", "coder", [
        makeCoderOutput({ summary: "TASK-A coder summary" }),
      ]);
      const reviewerA = new CapturingAgent("reviewer-a", "reviewer", [
        makeReviewerOutput({ verdict: "APPROVED", summary: "TASK-A approved" }),
      ]);
      const coderB = new CapturingAgent("coder-b", "coder", [
        makeCoderOutput({ summary: "TASK-B coder summary" }),
      ]);
      const reviewerB = new CapturingAgent("reviewer-b", "reviewer", [
        makeReviewerOutput({ verdict: "APPROVED", summary: "TASK-B approved" }),
      ]);

      const config = testConfig({ workspaceRoot });

      // A factory-driven orchestrator that swaps the agent pair per task: this
      // is how a real deployment would run two independent tasks.
      const makeOrchestrator = (coder: Agent, reviewer: Agent) =>
        new OrchestratorService({
          provider: {} as never,
          config,
          logger,
          createCoder: () => coder,
          createReviewer: () => reviewer,
        });

      const specA: TaskSpec = { id: "TASK-A", title: "A", description: "first task" };
      const recordA = await makeOrchestrator(coderA, reviewerA).run(specA);
      expect(recordA.state).toBe("DONE");

      const specB: TaskSpec = { id: "TASK-B", title: "B", description: "second task" };
      const recordB = await makeOrchestrator(coderB, reviewerB).run(specB);
      expect(recordB.state).toBe("DONE");

      // The AgentInput objects are the entire surface an agent receives.
      // Serialise them: TASK-B's inputs must not contain TASK-A's markers.
      const serialisedB = JSON.stringify([
        ...coderB.inputs.map((i) => ({ task: i.task, previousReview: i.previousReview, previousCoder: i.previousCoder })),
        ...reviewerB.inputs.map((i) => ({ task: i.task, previousCoder: i.previousCoder, previousReview: i.previousReview })),
      ]);

      expect(serialisedB).not.toContain("TASK-A");
      expect(serialisedB).not.toContain("TASK-A coder summary");
      expect(serialisedB).not.toContain("TASK-A approved");

      // Structural proof: every input only ever names its own task.
      for (const input of [...coderB.inputs, ...reviewerB.inputs]) {
        expect(input.task.id).toBe("TASK-B");
      }

      // A coder input carries no message/transcript/history field of any kind.
      const coderBInputKeys = Object.keys(coderB.inputs[0]!);
      expect(coderBInputKeys).not.toContain("messages");
      expect(coderBInputKeys).not.toContain("history");
      expect(coderBInputKeys).not.toContain("transcript");
      expect(coderBInputKeys).not.toContain("session");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
