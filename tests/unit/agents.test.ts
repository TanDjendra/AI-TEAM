import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoderAgent } from "../../src/agents/coder-agent.js";
import { ReviewerAgent } from "../../src/agents/reviewer-agent.js";
import { CommandRunner } from "../../src/agents/tools.js";
import { Workspace } from "../../src/agents/workspace.js";
import { createLogger } from "../../src/domain/logger.js";
import type { AgentInput, TaskSpec } from "../../src/domain/types.js";
import type {
  ChatStreamChunk,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ProviderHealth,
} from "../../src/providers/model-provider.js";
import {
  extractJsonObject,
  parseToolCalls,
} from "../../src/agents/base-agent.js";
import { cleanupDir, makeTempDir } from "../helpers/index.js";

/**
 * A scripted model provider.
 *
 * This is NOT a fake 9Router and it is NOT a fake tool loop: it substitutes only
 * the `ModelProvider` seam (which exists precisely so the transport can be
 * swapped). Every tool call it requests is executed for real by `CoderAgent`
 * against the real filesystem and real processes.
 *
 * Each script entry is one model turn:
 *   - a string        → a text turn (may contain an XML/fenced tool call)
 *   - { content, toolCalls } → a native turn with `tool_calls`
 */
type ScriptedTurn = string | { content?: string; toolCalls: Array<{ name: string; arguments: string; id?: string }> };

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly baseUrl = "http://scripted.invalid/v1";
  readonly calls: ModelRequest[] = [];

  constructor(private readonly script: ScriptedTurn[]) {}

  /** Turn seen by the model, with the tool calls it requested. */
  async chat(input: ModelRequest): Promise<ModelResponse> {
    this.calls.push(input);
    const index = this.calls.length - 1;
    const turn = this.script[index] ?? this.script[this.script.length - 1] ?? "";

    const content = typeof turn === "string" ? turn : (turn.content ?? "");
    const rawCalls = typeof turn === "string" ? [] : turn.toolCalls;

    const toolCalls: ModelToolCall[] = rawCalls.map((call, i) => {
      const out: ModelToolCall = {
        id: call.id ?? `call_${index}_${i}`,
        name: call.name,
        argumentsRaw: call.arguments,
      };
      try {
        const parsed: unknown = JSON.parse(call.arguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.args = parsed as Record<string, unknown>;
        } else {
          out.parseError = "arguments must be a JSON object";
        }
      } catch (error) {
        out.parseError = error instanceof Error ? error.message : String(error);
      }
      return out;
    });

    return {
      id: `resp-${this.calls.length}`,
      resolvedModel: "deepseek-v4.1-flash",
      requestedModel: input.model,
      content,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      latencyMs: 5,
      attempts: 1,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  // eslint-disable-next-line require-yield
  async *chatStream(_input: ModelRequest): AsyncGenerator<ChatStreamChunk, ModelResponse, void> {
    throw new Error("not used in these tests");
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, baseUrl: this.baseUrl, latencyMs: 1 };
  }
}

const TASK: TaskSpec = {
  id: "TASK-001",
  title: "Create a string utility module with tests",
  description: "Create src/index.js and a passing test, then run the tests.",
  acceptanceCriteria: ["the test command exits 0"],
};

const FINAL_DONE = JSON.stringify({
  status: "DONE",
  summary: "implemented and verified",
  files_changed: ["src/index.js"],
  tests_run: ["node --test"],
  tests_passed: true,
  issues: [],
  notes: "",
});

const logger = createLogger({ level: "error", sink: () => {} });

/** A real, passing Node test file so `node --test` genuinely exits 0. */
const PASSING_TEST =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => { assert.equal(1, 1); });\n';

const IMPLEMENTATION = "export const slugify = (value) => String(value).trim().toLowerCase();\n";

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await makeTempDir();
  workspace = new Workspace(root);
});

afterEach(async () => {
  await cleanupDir(root);
});

function coderInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return { task: TASK, workspacePath: root, cycle: 1, reason: "INITIAL", ...overrides };
}

function makeCoder(provider: ModelProvider, options: { maxToolTurns?: number } = {}) {
  return new CoderAgent({
    provider,
    model: "grip/deepseek-v4.1-flash",
    workspace,
    logger,
    runner: new CommandRunner({ timeoutMs: 60_000 }),
    ...(options.maxToolTurns === undefined ? {} : { maxToolTurns: options.maxToolTurns }),
  });
}

// ===========================================================================
// Tool-call parsing (the regression surface for TASK-001)
// ===========================================================================

describe("tool-call parsing", () => {
  it("parses the native XML form DeepSeek actually emitted (TASK-001 regression)", () => {
    const text = `I'll start by inspecting the workspace.

<tool_call>
<invoke name="bash">
<parameter name="command">pwd && ls -la && node --version</parameter>
</invoke>
</tool_call>`;

    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("bash");
    expect(calls[0]!.args).toEqual({ command: "pwd && ls -la && node --version" });
    expect(calls[0]!.source).toBe("xml");
  });

  it("parses XML with several parameters", () => {
    const calls = parseToolCalls(
      '<tool_call><invoke name="write_file"><parameter name="path">a.js</parameter><parameter name="content">x = 1;</parameter></invoke></tool_call>',
    );
    expect(calls[0]!.tool).toBe("write_file");
    expect(calls[0]!.args).toEqual({ path: "a.js", content: "x = 1;" });
  });

  it("parses multiple XML invokes in one turn", () => {
    const calls = parseToolCalls(
      [
        '<tool_call>',
        '<invoke name="write_file"><parameter name="path">a.js</parameter><parameter name="content">1</parameter></invoke>',
        '<invoke name="write_file"><parameter name="path">b.js</parameter><parameter name="content">2</parameter></invoke>',
        "</tool_call>",
      ].join(""),
    );
    expect(calls.map((call) => call.tool)).toEqual(["write_file", "write_file"]);
    expect(calls[1]!.args.path).toBe("b.js");
  });

  it("decodes XML entities inside parameter values", () => {
    const calls = parseToolCalls(
      '<tool_call><invoke name="write_file"><parameter name="content">if (a &lt; b &amp;&amp; c &gt; d) {}</parameter></invoke></tool_call>',
    );
    expect(calls[0]!.args.content).toBe("if (a < b && c > d) {}");
  });

  it("parses a Hermes-style JSON payload inside <tool_call> tags", () => {
    const calls = parseToolCalls(
      '<tool_call>{"name":"list_files","arguments":{"path":"."}}</tool_call>',
    );
    expect(calls[0]!.tool).toBe("list_files");
    expect(calls[0]!.args).toEqual({ path: "." });
  });

  it("still parses the fenced JSON form", () => {
    const calls = parseToolCalls(
      'ok\n```tool\n{"tool":"write_file","args":{"path":"a.js","content":"x"}}\n```',
    );
    expect(calls[0]!.tool).toBe("write_file");
    expect(calls[0]!.args).toEqual({ path: "a.js", content: "x" });
  });

  it("parses a bare JSON tool call", () => {
    const calls = parseToolCalls('{"tool":"list_files","args":{}}');
    expect(calls[0]!.tool).toBe("list_files");
  });

  it("does NOT mistake a final contract for a tool call", () => {
    // Regression guard: the completion contract has no tool/name key, and
    // `parseToolCalls` must return nothing so the loop can terminate.
    expect(parseToolCalls(FINAL_DONE)).toEqual([]);
  });

  it("returns nothing for plain prose", () => {
    expect(parseToolCalls("I have finished the task. Everything looks good.")).toEqual([]);
  });

  it("keeps argument values that contain braces intact", () => {
    const calls = parseToolCalls(
      '```tool\n{"tool":"write_file","args":{"path":"a.js","content":"function f() { return {a:1}; }"}}\n```',
    );
    expect(calls[0]!.args.content).toContain("return {a:1};");
  });
});

describe("JSON contract extraction", () => {
  it("extracts a fenced JSON object", () => {
    expect(extractJsonObject('```json\n{"verdict":"APPROVED"}\n```')).toEqual({ verdict: "APPROVED" });
  });

  it("extracts an object surrounded by prose", () => {
    expect(extractJsonObject('Here is my review:\n{"verdict":"REJECTED"}')).toEqual({
      verdict: "REJECTED",
    });
  });

  it("balances braces inside string values", () => {
    expect(extractJsonObject('{"summary":"use { and }","verdict":"REJECTED"}')).toMatchObject({
      verdict: "REJECTED",
    });
  });
});

// ===========================================================================
// CoderAgent — the real tool loop
// ===========================================================================

describe("CoderAgent tool loop", () => {
  it("executes a native tool call, feeds the result back, then takes the final contract", async () => {
    const provider = new ScriptedProvider([
      { content: "Inspecting.", toolCalls: [{ name: "list_files", arguments: "{}" }] },
      {
        content: "Writing the module.",
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "src/index.js", content: IMPLEMENTATION }) },
        ],
      },
      {
        content: "Adding a test.",
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "test/index.test.js", content: PASSING_TEST }) },
        ],
      },
      { content: "Running tests.", toolCalls: [{ name: "run_command", arguments: JSON.stringify({ command: "node --test" }) }] },
      FINAL_DONE,
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    // 1. the loop really ran: model → tool → model → tool → …  → final
    expect(provider.calls).toHaveLength(5);

    // 2. tools were actually executed against the real workspace
    expect(await workspace.fileExists("src/index.js")).toBe(true);
    expect(await workspace.fileExists("test/index.test.js")).toBe(true);

    // 3. the harness-verified facts are the authoritative report
    expect(output.status).toBe("DONE");
    expect(output.files_changed).toEqual(["src/index.js", "test/index.test.js"]);
    expect(output.tests_run).toEqual(["node --test"]);
    expect(output.tests_passed).toBe(true);
    expect(output.ok).toBe(true);
    expect(output.executed_commands?.[0]?.exitCode).toBe(0);
  });

  it("sends native tool definitions and answers tool calls with role=tool", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "list_files", arguments: "{}", id: "call_abc" }] },
      FINAL_DONE,
    ]);

    await makeCoder(provider).execute(coderInput());

    const first = provider.calls[0]!;
    expect(first.tools?.length).toBeGreaterThan(0);
    expect(first.tools?.map((tool) => tool.function.name)).toContain("write_file");
    expect(first.toolChoice).toBe("auto");

    // The assistant echo carries the tool call…
    const second = provider.calls[1]!;
    const assistant = second.messages.find((message) => message.role === "assistant" && message.toolCalls?.length);
    expect(assistant?.toolCalls?.[0]?.id).toBe("call_abc");
    expect(assistant?.toolCalls?.[0]?.name).toBe("list_files");

    // …and is followed by a tool result keyed on the same id.
    const toolMessage = second.messages.find((message) => message.role === "tool");
    expect(toolMessage?.toolCallId).toBe("call_abc");
  });

  it("executes several tool calls from a single turn", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "A" }) },
          { name: "write_file", arguments: JSON.stringify({ path: "b.txt", content: "B" }) },
        ],
      },
      FINAL_DONE,
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    expect(await workspace.fileExists("a.txt")).toBe(true);
    expect(await workspace.fileExists("b.txt")).toBe(true);
    expect(output.files_changed).toContain("a.txt");
    expect(output.files_changed).toContain("b.txt");
    expect(output.files_changed).toHaveLength(2);
  });

  it("recovers an XML tool call from text instead of treating it as a final answer (TASK-001 regression)", async () => {
    // This is exactly the shape DeepSeek produced in the failing E2E run.
    const provider = new ScriptedProvider([
      `I'll start by inspecting the workspace, then implement the package.

<tool_call>
<invoke name="write_file">
<parameter name="path">src/index.js</parameter>
<parameter name="content">${IMPLEMENTATION}</parameter>
</invoke>
</tool_call>`,
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "test/index.test.js", content: PASSING_TEST }) },
          { name: "run_command", arguments: JSON.stringify({ command: "node --test" }) },
        ],
      },
      FINAL_DONE,
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    // The XML call was executed for real — this is the bug that must not return.
    expect(await workspace.fileExists("src/index.js")).toBe(true);
    expect(output.files_changed).toContain("src/index.js");
    expect(output.issues.join(" ")).not.toContain("no parsable contract");
    expect(output.contractParsed).toBe(true);
  });

  it("keeps looping through the XML path across turns", async () => {
    const provider = new ScriptedProvider([
      `<tool_call><invoke name="list_files"></invoke></tool_call>`,
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "src/index.js", content: IMPLEMENTATION }) },
          { name: "write_file", arguments: JSON.stringify({ path: "test/index.test.js", content: PASSING_TEST }) },
          { name: "run_command", arguments: JSON.stringify({ command: "node --test" }) },
        ],
      },
      FINAL_DONE,
    ]);

    const output = await makeCoder(provider).execute(coderInput());
    expect(output.tests_passed).toBe(true);
    expect(output.status).toBe("DONE");
  });

  it("marks the coder BLOCKED when the model stops without calling any tool", async () => {
    const provider = new ScriptedProvider([
      "Sure — here is how one would implement this. First, create a package.json…",
      "In summary, the approach is to add a slugify function.",
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    expect(output.status).toBe("BLOCKED");
    expect(output.ok).toBe(false);
    expect(output.tests_passed).toBe(false);
    expect(output.files_changed).toEqual([]);
    expect(output.issues.join(" ")).toMatch(/no tool calls at all/i);
    // Nothing was written, and the run did not pretend otherwise.
    expect(output.executed_commands).toEqual([]);
  });

  it("refuses a DONE claim when the model performed no work at all", async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        status: "DONE",
        summary: "All done, tests pass!",
        files_changed: ["src/index.js"],
        tests_run: ["npm test"],
        tests_passed: true,
        issues: [],
        notes: "",
      }),
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    expect(output.status).toBe("BLOCKED");
    expect(output.ok).toBe(false);
    expect(output.issues.join(" ")).toMatch(/no tool calls at all/i);
    // The invented claims were overwritten by the verified (empty) truth.
    expect(output.files_changed).toEqual([]);
    expect(output.tests_run).toEqual([]);
    expect(output.tests_passed).toBe(false);
  });

  it("refuses a DONE claim when changes were made but no test was ever run", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "src/index.js", content: IMPLEMENTATION }) },
        ],
      },
      JSON.stringify({
        status: "DONE",
        summary: "implemented",
        files_changed: ["src/index.js"],
        tests_run: ["npm test"],
        tests_passed: true,
        issues: [],
        notes: "",
      }),
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    expect(output.status).toBe("BLOCKED");
    expect(output.files_changed).toEqual(["src/index.js"]);
    expect(output.tests_run).toEqual([]);
    expect(output.tests_passed).toBe(false);
    expect(output.issues.join(" ")).toMatch(/never executed a test command/i);
  });

  it("hands a tool execution error back to the model so it can retry", async () => {
    const provider = new ScriptedProvider([
      // 1. escapes the sandbox → the tool refuses
      { toolCalls: [{ name: "write_file", arguments: JSON.stringify({ path: "../evil.js", content: "x" }) }] },
      // 2. corrected path → succeeds
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "src/index.js", content: IMPLEMENTATION }) },
          { name: "write_file", arguments: JSON.stringify({ path: "test/index.test.js", content: PASSING_TEST }) },
          { name: "run_command", arguments: JSON.stringify({ command: "node --test" }) },
        ],
      },
      FINAL_DONE,
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    // The error was delivered to the model as a tool result…
    const retryTurn = provider.calls[1]!;
    const errorResult = retryTurn.messages.find(
      (message) => message.role === "tool" && message.content.includes("escapes the workspace"),
    );
    expect(errorResult).toBeDefined();

    // …and the model recovered.
    expect(await workspace.fileExists("src/index.js")).toBe(true);
    expect(output.status).toBe("DONE");
    expect(output.tests_passed).toBe(true);
  });

  it("reports an unknown tool back to the model instead of crashing", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "bash", arguments: JSON.stringify({ command: "ls" }) }] },
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "src/index.js", content: IMPLEMENTATION }) },
          { name: "write_file", arguments: JSON.stringify({ path: "test/index.test.js", content: PASSING_TEST }) },
          { name: "run_command", arguments: JSON.stringify({ command: "node --test" }) },
        ],
      },
      FINAL_DONE,
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    const toolMessage = provider.calls[1]!.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toMatch(/unknown tool "bash"/);
    expect(output.notes).toContain("unknown tool(s): bash");
  });

  it("hands a malformed tool call back to the model so it can correct itself", async () => {
    const provider = new ScriptedProvider([
      // 1. `arguments` is not valid JSON
      { toolCalls: [{ name: "write_file", arguments: '{"path": "src/index.js", "content": ' }] },
      // 2. valid call
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "src/index.js", content: IMPLEMENTATION }) },
          { name: "write_file", arguments: JSON.stringify({ path: "test/index.test.js", content: PASSING_TEST }) },
          { name: "run_command", arguments: JSON.stringify({ command: "node --test" }) },
        ],
      },
      FINAL_DONE,
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    const errorResult = provider.calls[1]!.messages.find(
      (message) => message.role === "tool" && message.content.includes("could not parse the arguments"),
    );
    expect(errorResult).toBeDefined();
    expect(errorResult?.content).toContain("Call the tool again with a valid JSON object");

    expect(await workspace.fileExists("src/index.js")).toBe(true);
    expect(output.status).toBe("DONE");
  });

  it("forces a final answer once max tool turns are exhausted", async () => {
    // The model never stops asking for tools.
    const loop = {
      toolCalls: [{ name: "list_files", arguments: "{}" }] as Array<{ name: string; arguments: string }>,
    };
    const provider = new ScriptedProvider([loop, loop, loop, loop, loop, loop, FINAL_DONE]);

    const output = await makeCoder(provider, { maxToolTurns: 3 }).execute(coderInput());

    // 3 working turns + 1 forced-answer turn.
    expect(provider.calls).toHaveLength(4);

    // The forced turn forbids further tools while keeping the schema visible.
    const finalRequest = provider.calls.at(-1)!;
    expect(finalRequest.toolChoice).toBe("none");
    expect(finalRequest.tools?.length).toBeGreaterThan(0);
    expect(finalRequest.messages.at(-1)?.content).toMatch(/Stop calling tools|out of tool turns/i);

    // No work was done, so it cannot be DONE.
    expect(output.status).toBe("BLOCKED");
  });

  it("marks the run unusable when the model never emits a contract", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "list_files", arguments: "{}" }] },
      "Let me think about that some more.",
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    expect(output.contractParsed).toBe(false);
    expect(output.status).toBe("BLOCKED");
    expect(output.ok).toBe(false);
    expect(output.issues.join(" ")).toContain("parsable");
  });

  it("reports a real failing test as not passed and not ok", async () => {
    const failingTest =
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("fails", () => { assert.equal(1, 2); });\n';

    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "test/broken.test.js", content: failingTest }) },
          { name: "run_command", arguments: JSON.stringify({ command: "node --test" }) },
        ],
      },
      JSON.stringify({
        status: "DONE",
        summary: "everything is fine",
        files_changed: ["test/broken.test.js"],
        tests_run: ["node --test"],
        tests_passed: true,
        issues: [],
        notes: "",
      }),
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    expect(output.executed_commands?.[0]?.exitCode).not.toBe(0);
    expect(output.tests_passed).toBe(false);
    expect(output.ok).toBe(false);
  });

  it("catches a coder that claims tests it never ran", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "src/index.js", content: IMPLEMENTATION }) },
        ],
      },
      JSON.stringify({
        status: "DONE",
        summary: "verified",
        files_changed: ["src/index.js"],
        tests_run: ["npm test"],
        tests_passed: true,
        issues: [],
        notes: "",
      }),
    ]);

    const output = await makeCoder(provider).execute(coderInput());
    expect(output.issues.join(" ")).toMatch(/never executed|executed no test command/i);
    expect(output.tests_passed).toBe(false);
  });

  it("catches a coder that claims files it never wrote", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "src/real.js", content: "x\n" }) },
        ],
      },
      JSON.stringify({
        status: "DONE",
        summary: "done",
        files_changed: ["src/real.js", "src/invented.js"],
        tests_run: [],
        tests_passed: false,
        issues: [],
        notes: "",
      }),
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    expect(output.files_changed).toEqual(["src/real.js"]);
    expect(output.issues.join(" ")).toContain("src/invented.js");
  });

  it("includes the reviewer feedback and a fix instruction on a FIX run", async () => {
    const provider = new ScriptedProvider([FINAL_DONE]);

    await makeCoder(provider).execute(
      coderInput({
        reason: "FIX",
        cycle: 2,
        previousReview: {
          agentId: "reviewer",
          role: "reviewer",
          ok: true,
          verdict: "REJECTED",
          summary: "missing edge cases",
          issues: ["slugify does not handle empty input"],
          required_fixes: ["handle empty input"],
          severity: "MEDIUM",
        },
      }),
    );

    const prompt = provider.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("handle empty input");
    expect(prompt).toContain("Do not only describe the fixes");
    expect(prompt).toContain("Actually modify the files and run the tests");
  });

  it("uses the initial-run instruction telling the model to act, not explain", async () => {
    const provider = new ScriptedProvider([FINAL_DONE]);
    await makeCoder(provider).execute(coderInput({ reason: "INITIAL" }));

    const prompt = provider.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("You are an autonomous coding agent");
    expect(prompt).toContain("Do not merely explain what should be done");
    expect(prompt).toContain("Inspect the workspace and perform the task using the available tools");
  });

  it("uses the LAST test run as the authoritative result (real TASK-001 shape)", async () => {
    // Observed in production: an exploratory compound command exited non-zero
    // before the real suite passed. Requiring every historical command to be
    // green made the report contradict its own APPROVED verdict.
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "src/index.js", content: IMPLEMENTATION }) },
          { name: "write_file", arguments: JSON.stringify({ path: "test/index.test.js", content: PASSING_TEST }) },
        ],
      },
      // exploratory probe that fails
      {
        toolCalls: [
          {
            name: "run_command",
            arguments: JSON.stringify({ command: 'node --version; echo "---"; node --test test/index.test.js | grep nope' }),
          },
        ],
      },
      // the real suite, which passes
      { toolCalls: [{ name: "run_command", arguments: JSON.stringify({ command: "node --test" }) }] },
      FINAL_DONE,
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    const exits = output.executed_commands?.map((command) => command.exitCode) ?? [];
    expect(exits.at(-1), "the final test command must have passed").toBe(0);
    expect(exits.some((code) => code !== 0), "an earlier probe must have failed").toBe(true);

    // Verified truth is green, and the earlier failure is reported, not fatal.
    expect(output.tests_passed).toBe(true);
    expect(output.status).toBe("DONE");
    expect(output.ok).toBe(true);
    expect(output.issues).toEqual([]);
    expect(output.notes).toContain("final test command -> exit 0");
    expect(output.notes).toContain("earlier test-class command(s) exited non-zero");
  });

  it("still fails the run when the final test command fails", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "run_command", arguments: JSON.stringify({ command: "node --test test/missing.test.js" }) }] },
      JSON.stringify({
        status: "DONE",
        summary: "done",
        files_changed: [],
        tests_run: ["node --test"],
        tests_passed: true,
        issues: [],
        notes: "",
      }),
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    expect(output.executed_commands?.at(-1)?.exitCode).not.toBe(0);
    expect(output.tests_passed).toBe(false);
    expect(output.status).toBe("BLOCKED");
    expect(output.issues.join(" ")).toMatch(/final test command exited/i);
  });

  it("fails the run when any test command timed out", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: "write_file", arguments: JSON.stringify({ path: "test/index.test.js", content: PASSING_TEST }) },
        ],
      },
      // A hung test tells us nothing, even if a later run passes.
      { toolCalls: [{ name: "run_command", arguments: JSON.stringify({ command: "node --test --watch", timeoutMs: 1500 }) }] },
      { toolCalls: [{ name: "run_command", arguments: JSON.stringify({ command: "node --test" }) }] },
      FINAL_DONE,
    ]);

    const output = await makeCoder(provider).execute(coderInput());

    const timedOut = output.executed_commands?.some((command) => command.timedOut) ?? false;
    expect(timedOut, "the hung command should have been recorded as timed out").toBe(true);
    expect(output.tests_passed).toBe(false);
    expect(output.status).toBe("BLOCKED");
  });

  it("always returns a normalised contract, even on an infrastructure error", async () => {
    const failing: ModelProvider = {
      id: "failing",
      baseUrl: "http://failing.invalid/v1",
      chat: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
      // eslint-disable-next-line require-yield
      chatStream: async function* () {
        throw new Error("unused");
      },
      listModels: async () => [],
      health: async () => ({ ok: false, baseUrl: "http://failing.invalid/v1", latencyMs: 0 }),
    };

    const output = await makeCoder(failing).execute(coderInput());

    expect(output.role).toBe("coder");
    expect(output.contractParsed).toBe(false);
    expect(output.status).toBe("BLOCKED");
    expect(output.error).toContain("unreachable");
  });
});

// ===========================================================================
// ReviewerAgent — unchanged strictness
// ===========================================================================

describe("ReviewerAgent — evidence-driven verification", () => {
  const coderContractWithEvidence = {
    agentId: "coder",
    role: "coder" as const,
    ok: true,
    contractParsed: true,
    status: "DONE" as const,
    summary: "implemented",
    files_changed: ["src/index.js"],
    tests_run: ["node --test"],
    tests_passed: true,
    issues: [],
    notes: "",
    executed_commands: [{ command: "node --test", exitCode: 0, timedOut: false, output: "# pass 1" }],
  };

  it("receives the real file content and the real command log", async () => {
    await workspace.writeText("src/index.js", IMPLEMENTATION);
    const provider = new ScriptedProvider([
      JSON.stringify({ verdict: "APPROVED", summary: "ok", issues: [], required_fixes: [], severity: "NONE" }),
    ]);
    const agent = new ReviewerAgent({ provider, model: "grip/gpt-5.6-luna", workspace, logger });

    await agent.execute({
      task: TASK,
      workspacePath: root,
      cycle: 1,
      reason: "INITIAL",
      previousExecutions: coderContractWithEvidence.executed_commands,
      previousCoder: coderContractWithEvidence,
    });

    const prompt = provider.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("src/index.js");
    expect(prompt).toContain("node --test");
    expect(prompt).toContain("exit 0");
    expect(prompt).toContain("WHAT THE HARNESS COULD NOT VERIFY");
  });

  it("flags a green claim with no recorded command", async () => {
    await workspace.writeText("src/index.js", IMPLEMENTATION);
    const provider = new ScriptedProvider([
      JSON.stringify({ verdict: "REJECTED", summary: "no proof", issues: ["unverified"], required_fixes: ["run the tests"], severity: "HIGH" }),
    ]);
    const agent = new ReviewerAgent({ provider, model: "m", workspace, logger });

    await agent.execute({
      task: TASK,
      workspacePath: root,
      cycle: 1,
      reason: "INITIAL",
      previousCoder: { ...coderContractWithEvidence, executed_commands: [] },
    });

    const prompt = provider.calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("NO COMMAND WAS EXECUTED");
    expect(prompt).toContain("no command execution was recorded");
  });

  it("parses a REJECTED verdict with fixes", async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        verdict: "REJECTED",
        summary: "edge cases missing",
        issues: ["slugify crashes on empty input"],
        required_fixes: ["handle empty input"],
        severity: "MEDIUM",
      }),
    ]);
    const agent = new ReviewerAgent({ provider, model: "m", workspace, logger });
    const output = await agent.execute({ task: TASK, workspacePath: root, cycle: 1, reason: "INITIAL" });

    expect(output.verdict).toBe("REJECTED");
    expect(output.required_fixes).toEqual(["handle empty input"]);
  });

  it("still downgrades an APPROVED that contradicts a CRITICAL severity", async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({ verdict: "APPROVED", summary: "sure", issues: ["data loss"], required_fixes: [], severity: "CRITICAL" }),
    ]);
    const agent = new ReviewerAgent({ provider, model: "m", workspace, logger });
    const output = await agent.execute({ task: TASK, workspacePath: root, cycle: 1, reason: "INITIAL" });

    expect(output.verdict).toBe("REJECTED");
    expect(output.summary).toContain("downgraded");
  });

  it("still downgrades an APPROVED that lists required fixes", async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({ verdict: "APPROVED", summary: "sure", issues: [], required_fixes: ["add the test"], severity: "NONE" }),
    ]);
    const agent = new ReviewerAgent({ provider, model: "m", workspace, logger });
    const output = await agent.execute({ task: TASK, workspacePath: root, cycle: 1, reason: "INITIAL" });

    expect(output.verdict).toBe("REJECTED");
  });

  it("never approves by accident when the verdict is unreadable", async () => {
    const provider = new ScriptedProvider(["probably fine?", "yeah looks good", "ok"]);
    const agent = new ReviewerAgent({ provider, model: "m", workspace, logger });
    const output = await agent.execute({ task: TASK, workspacePath: root, cycle: 1, reason: "INITIAL" });

    expect(output.verdict).toBe("REJECTED");
    expect(output.contractParsed).toBe(false);
    expect(provider.calls).toHaveLength(3);
  });

  it("returns a REJECTED verdict when the reviewer call itself fails", async () => {
    const failing: ModelProvider = {
      id: "failing",
      baseUrl: "http://failing.invalid/v1",
      chat: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
      // eslint-disable-next-line require-yield
      chatStream: async function* () {
        throw new Error("unused");
      },
      listModels: async () => [],
      health: async () => ({ ok: false, baseUrl: "http://failing.invalid/v1", latencyMs: 0 }),
    };

    const agent = new ReviewerAgent({ provider: failing, model: "m", workspace, logger });
    const output = await agent.execute({ task: TASK, workspacePath: root, cycle: 1, reason: "INITIAL" });

    expect(output.verdict).toBe("REJECTED");
    expect(output.contractParsed).toBe(false);
  });
});
