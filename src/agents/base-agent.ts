/**
 * Shared agent plumbing: JSON extraction, tool-call parsing and the provider
 * accounting helpers used by both concrete agents.
 */

import type {
  AgentInput,
  AgentOutput,
  AgentResult,
  TokenUsage,
} from "../domain/types.js";
import type { ModelMessage } from "../providers/model-provider.js";

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** How the call was recovered — useful in logs and tests. */
  source: "native" | "fence" | "json" | "xml";
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, inputTokens: 0, outputTokens: 0 };
}

export function addUsage(target: TokenUsage, addition: TokenUsage): TokenUsage {
  return {
    promptTokens: target.promptTokens + addition.promptTokens,
    completionTokens: target.completionTokens + addition.completionTokens,
    totalTokens: target.totalTokens + addition.totalTokens,
    cachedTokens: (target.cachedTokens ?? 0) + (addition.cachedTokens ?? 0),
    inputTokens: (target.inputTokens ?? 0) + (addition.inputTokens ?? 0),
    outputTokens: (target.outputTokens ?? 0) + (addition.outputTokens ?? 0),
  };
}

/**
 * Normalises a native provider tool call into the agent's `ToolCall`.
 * Returns undefined when the provider emitted a malformed call.
 */
export function nativeToolCallToToolCall(
  call: { id: string; name: string; args?: Record<string, unknown>; parseError?: string },
): ToolCall | undefined {
  if (call.parseError || !call.args) return undefined;
  return { id: call.id, tool: call.name, args: call.args, source: "native" };
}

/** Marker used by the coder's fenced tool protocol. */
const TOOL_FENCE = /```(?:tool|json)?\s*([\s\S]*?)```/;

/**
 * Recovers tool calls that a model emitted as TEXT rather than through the
 * provider's native `tool_calls` channel.
 *
 * This fallback exists because of a real, observed failure: DeepSeek V4.1 Flash
 * emitted its tool call as native XML — `I'll start by inspecting the workspace.`
 * followed by `<tool_call>...<invoke name="bash">...` — and the previous version
 * of this code treated that text as a *final answer*, so the coder never ran a
 * single tool and every task ended BLOCKED. Text-shaped tool calls are therefore
 * first-class input, not an error.
 *
 * Supported shapes:
 *   1. XML      <tool_call><invoke name="x"><parameter name="k">v</parameter>…
 *   2. Hermes   <tool_call>{"name":"x","arguments":{…}}</tool_call>
 *   3. Fenced   ```tool {"tool":"x","args":{…}} ```
 *   4. Bare     {"tool":"x","args":{…}}
 *
 * Bare JSON is tried LAST so a legitimate final contract object (which has no
 * `tool`/`name` key) is never mistaken for a tool call.
 */
export function parseToolCalls(text: string): ToolCall[] {
  const calls = scanToolCalls(text);
  if (calls.length > 0) return calls;

  // Fallback: a single fenced/bare JSON tool call somewhere in the text.
  const single = parseSingleJsonToolCall(text);
  return single ? [single] : [];
}

function scanToolCalls(text: string): ToolCall[] {
  if (!text) return [];
  const calls: ToolCall[] = [];

  // --- 1 & 2: <tool_call> blocks -----------------------------------------
  const blockPattern = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(text)) !== null) {
    const inner = block[1] ?? "";
    const invokePattern = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi;
    let invoke: RegExpExecArray | null;
    let found = false;

    while ((invoke = invokePattern.exec(inner)) !== null) {
      found = true;
      calls.push({
        id: `text_${calls.length}`,
        tool: invoke[1]!.trim(),
        args: parseInvokeParameters(invoke[2] ?? ""),
        source: "xml",
      });
    }

    if (!found) {
      // Hermes-style JSON payload inside the tags.
      const parsed = tryParseObject(inner.trim());
      const call = parsed ? toolCallFromObject(parsed, `text_${calls.length}`) : undefined;
      if (call) calls.push(call);
    }
  }
  if (calls.length > 0) return calls;

  // --- bare <invoke> without the wrapper ---------------------------------
  const looseInvoke = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi;
  let loose: RegExpExecArray | null;
  while ((loose = looseInvoke.exec(text)) !== null) {
    calls.push({
      id: `text_${calls.length}`,
      tool: loose[1]!.trim(),
      args: parseInvokeParameters(loose[2] ?? ""),
      source: "xml",
    });
  }

  return calls;
}

/** Parses `<parameter name="k">value</parameter>` bodies. */
function parseInvokeParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const pattern = /<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const key = match[1]!.trim();
    const value = decodeXmlEntities((match[2] ?? "").trim());
    args[key] = coerceValue(value);
  }
  return args;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Strings stay strings; only obviously-typed scalars are coerced. */
function coerceValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  return value;
}

function parseSingleJsonToolCall(text: string): ToolCall | undefined {
  const candidates: string[] = [];

  const fence = TOOL_FENCE.exec(text);
  if (fence?.[1]) candidates.push(fence[1]);

  const trimmed = text.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    const parsed = tryParseObject(candidate);
    if (!parsed) continue;
    const call = toolCallFromObject(parsed, "json_0");
    if (call) return call;
  }
  return undefined;
}

/** Recognises the several key spellings models use for a JSON tool call. */
function toolCallFromObject(parsed: Record<string, unknown>, id: string): ToolCall | undefined {
  const toolName =
    typeof parsed.tool === "string"
      ? parsed.tool
      : typeof parsed.name === "string"
        ? parsed.name
        : typeof parsed.tool_name === "string"
          ? parsed.tool_name
          : undefined;
  if (!toolName) return undefined;

  const rawArgs = parsed.args ?? parsed.arguments ?? parsed.parameters ?? parsed.input ?? {};
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  return { id, tool: toolName, args, source: "json" };
}

/** Extracts the first genuine JSON object from a model reply. */
export function extractJsonObject(text: string): unknown {
  const withoutFences = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  const direct = tryParseObject(withoutFences);
  if (direct) return direct;

  // Scan for a balanced object, ignoring braces inside strings.
  const source = withoutFences;
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          const candidate = tryParseObject(source.slice(start, i + 1));
          if (candidate) return candidate;
          break;
        }
      }
    }
  }
  return undefined;
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .filter((entry) => entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface BaseAgentContext {
  id: string;
  role: string;
}

/** Shared shape for "the model produced garbage" results. */
export function invalidOutput(params: {
  agentId: string;
  role: string;
  error: string;
  raw: string;
  usage?: TokenUsage;
  resolvedModel?: string;
}): AgentOutput {
  return {
    agentId: params.agentId,
    role: params.role,
    ok: false,
    error: params.error,
    raw: params.raw,
    ...(params.usage ? { usage: params.usage } : {}),
    ...(params.resolvedModel ? { resolvedModel: params.resolvedModel } : {}),
  };
}

export function messagesInputHint(input: AgentInput): ModelMessage[] {
  return [{ role: "user", content: input.task.description }];
}

export function toAgentResult<T extends AgentOutput>(
  output: T,
  attempts: AgentResult<T>["attempts"],
): AgentResult<T> {
  return { output, attempts };
}
