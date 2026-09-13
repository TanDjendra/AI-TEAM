/**
 * Real 9Router ModelProvider (OpenAI-compatible HTTP).
 *
 * Verified against a live 9Router instance:
 *   - Base URL: http://localhost:20128/v1   (local router, OpenAI-compatible)
 *   - GET  {base}/models              -> { object: "list", data: [{ id, owned_by, ... }] }
 *   - POST {base}/chat/completions    -> standard chat.completion object
 *   - Streaming uses SSE `data: {...}` frames terminated by `data: [DONE]`
 *   - IMPORTANT: 9Router appends a trailing `data: [DONE]` to *non-streaming*
 *     responses too, so the JSON body must be sliced at the first `data:` marker.
 *
 * Nothing is faked: every method performs a real network call and fails loudly
 * when the router is unreachable.
 */

import {
  RouterError,
  classifyHttpStatus,
  scrubSecrets,
  toRouterError,
  truncate,
} from "../domain/errors.js";
import type {
  ChatStreamChunk,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelUsage,
  ProviderHealth,
} from "./model-provider.js";

export interface RouterProviderOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Backoff base in ms; retries sleep base * 2^(n-1). */
  retryBaseDelayMs?: number;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChatChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; role?: string; tool_calls?: unknown };
    message?: {
      content?: string | null;
      tool_calls?: unknown;
      role?: string;
    };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

const STREAM_DONE = "[DONE]";

function emptyUsage(): ModelUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function readUsage(raw: WireUsage | null | undefined): ModelUsage {
  if (!raw) return emptyUsage();
  const promptTokens = raw.prompt_tokens ?? raw.input_tokens ?? 0;
  const completionTokens = raw.completion_tokens ?? raw.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: raw.total_tokens ?? promptTokens + completionTokens,
    cachedTokens: raw.cached_tokens,
    inputTokens: raw.input_tokens ?? raw.prompt_tokens,
    outputTokens: raw.output_tokens ?? raw.completion_tokens,
  };
}

interface WireModelList {
  data?: Array<{
    id?: string;
    context_length?: number;
    capabilities?: {
      contextWindow?: number;
      maxOutput?: number;
    };
  }>;
}

/**
 * Normalises `message.tool_calls` from the wire format.
 *
 * A malformed `arguments` string is NOT thrown away: the raw text is preserved
 * on `argumentsRaw` and the parse failure is recorded in `parseError`, so the
 * agent loop can hand the error back to the model and let it retry instead of
 * silently dropping the call.
 */
export function parseToolCalls(raw: unknown): ModelToolCall[] {
  if (!Array.isArray(raw)) return [];

  const calls: ModelToolCall[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const call = entry as WireToolCall;
    const fn = call.function;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) return;

    const argumentsRaw = typeof fn?.arguments === "string" ? fn.arguments : "";
    const out: ModelToolCall = {
      id: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
      name,
      argumentsRaw,
    };

    if (argumentsRaw.trim() === "") {
      // A tool with no arguments is legal (e.g. list_files).
      out.args = {};
    } else {
      try {
        const parsed: unknown = JSON.parse(argumentsRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.args = parsed as Record<string, unknown>;
        } else {
          out.parseError = `arguments must be a JSON object, received ${Array.isArray(parsed) ? "an array" : typeof parsed}`;
        }
      } catch (error) {
        out.parseError = error instanceof Error ? error.message : String(error);
      }
    }

    calls.push(out);
  });

  return calls;
}

/**
 * 9Router terminates even non-stream responses with `data: [DONE]`, which breaks
 * a naive `response.json()`.
 *
 * The stripping is done by locating the END OF THE JSON DOCUMENT with a
 * string-aware brace scan, not by searching for the literal "data:". A valid
 * payload may legitimately contain that text inside a string value.
 */
export function stripTrailingSseFrames(body: string): string {
  const trimmed = body.trim();

  if (trimmed.startsWith("{")) {
    const end = findJsonObjectEnd(trimmed);
    if (end !== -1) return trimmed.slice(0, end + 1);

    // No balanced object: fall back to cutting at an SSE terminator line.
    const doneIndex = trimmed.indexOf("\ndata: [DONE]");
    if (doneIndex > 0) return trimmed.slice(0, doneIndex).trim();
  }

  const doneLine = /\r?\ndata:\s*\[DONE\]/.exec(trimmed);
  if (doneLine && doneLine.index > 0) return trimmed.slice(0, doneLine.index).trim();

  return trimmed;
}

/** Index of the closing brace of the leading JSON object, or -1. */
function findJsonObjectEnd(text: string): number {
  if (!text.startsWith("{")) return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
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
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseChatResponse(bodyText: string, requestedModel: string, latencyMs: number, attempts: number): ModelResponse {
  const jsonText = stripTrailingSseFrames(bodyText);
  let parsed: WireChatChunk;
  try {
    parsed = JSON.parse(jsonText) as WireChatChunk;
  } catch (cause) {
    throw new RouterError(
      `9Router returned a non-JSON chat response for model "${requestedModel}"`,
      {
        kind: "parse",
        detail: scrubSecrets(truncate(bodyText, 400)),
        cause,
      },
    );
  }

  const choice = parsed.choices?.[0];
  if (!choice) {
    throw new RouterError(
      `9Router returned no choices for model "${requestedModel}"`,
      { kind: "parse", detail: scrubSecrets(truncate(bodyText, 400)) },
    );
  }

  // A tool-calling turn legitimately has `content: null`; normalise to "".
  const rawContent = choice.message?.content ?? choice.delta?.content ?? "";
  const content = typeof rawContent === "string" ? rawContent : "";

  const toolCalls = parseToolCalls(choice.message?.tool_calls);

  return {
    id: parsed.id ?? `local-${Date.now()}`,
    resolvedModel: parsed.model ?? requestedModel,
    requestedModel,
    content,
    finishReason: choice.finish_reason ?? "stop",
    usage: readUsage(parsed.usage),
    latencyMs,
    attempts,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/** Serialises one conversation message into the OpenAI wire shape. */
function toWireMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content,
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      // `content` must be present (possibly empty) alongside tool_calls.
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.argumentsRaw },
      })),
    };
  }

  return { role: message.role, content: message.content };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class RouterProvider implements ModelProvider {
  readonly id = "9router";
  readonly baseUrl: string;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBaseDelayMs: number;

  constructor(options: RouterProviderOptions) {
    if (!options.baseUrl) throw new RouterError("RouterProvider requires a baseUrl", { kind: "validation" });
    if (!options.apiKey) {
      throw new RouterError("RouterProvider requires an API key (check ROUTER_API_KEY)", {
        kind: "authentication",
        retryable: false,
      });
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 400;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      "user-agent": "ai-team-orchestrator/0.1.0",
    };
  }

  /** Performs one HTTP request with timeout + error normalisation. */
  private async request(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: init.method,
        headers: this.headers(),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await safeText(response);
        throw new RouterError(
          `9Router ${init.method} ${path} failed with ${response.status} ${response.statusText}`,
          {
            kind: classifyHttpStatus(response.status),
            status: response.status,
            requestId: response.headers.get("x-request-id") ?? undefined,
            detail: scrubSecrets(truncate(detail, 400)),
          },
        );
      }
      return response;
    } catch (error) {
      if (error instanceof RouterError) throw error;
      throw toRouterError(error, { url });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async withRetries<T>(operation: () => Promise<T>): Promise<{ value: T; attempts: number }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        return { value: await operation(), attempts: attempt };
      } catch (error) {
        lastError = error;
        const retryable = error instanceof RouterError ? error.retryable : false;
        if (!retryable || attempt > this.maxRetries) break;
        await sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  async chat(input: ModelRequest): Promise<ModelResponse> {
    // `tool_choice` is sent whenever the caller asked for it, even without a
    // `tools` array: the forced-final turn needs "none" to be explicit, because
    // the transcript still contains earlier tool calls and the model may try to
    // continue that pattern. Verified accepted by 9Router.
    const toolChoice = input.toolChoice ?? (input.tools?.length ? "auto" : undefined);

    const body = {
      model: input.model,
      messages: input.messages.map(toWireMessage),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
      ...(input.tools?.length ? { tools: input.tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      // `tools` and JSON mode are mutually exclusive: a JSON-object response
      // format would suppress tool calling.
      ...(input.json && !input.tools?.length ? { response_format: { type: "json_object" } } : {}),
      stream: false,
    };

    const startedAt = Date.now();
    const { value: response, attempts } = await this.withRetries(() =>
      this.request("/chat/completions", {
        method: "POST",
        body,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );

    const text = await safeText(response);
    return parseChatResponse(text, input.model, Date.now() - startedAt, attempts);
  }

  async *chatStream(
    input: ModelRequest,
  ): AsyncGenerator<ChatStreamChunk, ModelResponse, void> {
    const body = {
      model: input.model,
      messages: input.messages.map(toWireMessage),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
      ...(input.tools?.length ? { tools: input.tools, tool_choice: input.toolChoice ?? "auto" } : {}),
      stream: true,
    };

    const startedAt = Date.now();
    const { value: response, attempts } = await this.withRetries(() =>
      this.request("/chat/completions", {
        method: "POST",
        body,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );

    if (!response.body) {
      throw new RouterError("9Router streaming response had no body", { kind: "parse" });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let id = "";
    let resolvedModel = input.model;
    let finishReason = "stop";
    let usage = emptyUsage();

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === STREAM_DONE) {
              yield { delta: "", done: true };
              return {
                id: id || `local-${Date.now()}`,
                resolvedModel,
                requestedModel: input.model,
                content,
                finishReason,
                usage,
                latencyMs: Date.now() - startedAt,
                attempts,
              };
            }
            if (payload) {
              try {
                const chunk = JSON.parse(payload) as WireChatChunk;
                id ||= chunk.id ?? "";
                resolvedModel = chunk.model ?? resolvedModel;
                if (chunk.usage) usage = readUsage(chunk.usage);
                const choice = chunk.choices?.[0];
                if (choice?.finish_reason) finishReason = choice.finish_reason;
                const delta = choice?.delta?.content ?? choice?.message?.content ?? "";
                if (delta) {
                  content += delta;
                  yield { delta, done: false };
                }
              } catch {
                // Ignore malformed keep-alive/comment frames.
              }
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { delta: "", done: true };
    return {
      id: id || `local-${Date.now()}`,
      resolvedModel,
      requestedModel: input.model,
      content,
      finishReason,
      usage,
      latencyMs: Date.now() - startedAt,
      attempts,
    };
  }

  async listModels(): Promise<string[]> {
    const { value: response } = await this.withRetries(() =>
      this.request("/models", { method: "GET" }),
    );
    const text = await safeText(response);
    let parsed: WireModelList;
    try {
      parsed = JSON.parse(stripTrailingSseFrames(text)) as WireModelList;
    } catch (cause) {
      throw new RouterError("9Router /models returned non-JSON", {
        kind: "parse",
        detail: scrubSecrets(truncate(text, 300)),
        cause,
      });
    }
    return (parsed.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  async getModelMetadata(modelId: string): Promise<import("./model-provider.js").ModelMetadata | undefined> {
    const { value: response } = await this.withRetries(() =>
      this.request("/models", { method: "GET" }),
    );
    const text = await safeText(response);
    let parsed: WireModelList;
    try {
      parsed = JSON.parse(stripTrailingSseFrames(text)) as WireModelList;
    } catch {
      return undefined;
    }
    const model = (parsed.data ?? []).find((entry) => entry.id === modelId);
    if (!model) return undefined;
    
    // Check context_length (standard) or capabilities.contextWindow (9Router specific)
    const contextWindow = model.context_length ?? model.capabilities?.contextWindow;
    const maxOutput = model.capabilities?.maxOutput;
    
    return {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {})
    };
  }

  async health(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      const models = await this.listModels();
      return {
        ok: true,
        baseUrl: this.baseUrl,
        latencyMs: Date.now() - startedAt,
        modelCount: models.length,
        // /v1/models is unauthenticated on 9Router, so nothing is proven here.
        authVerified: false,
      };
    } catch (error) {
      return {
        ok: false,
        baseUrl: this.baseUrl,
        latencyMs: Date.now() - startedAt,
        authVerified: false,
        error: error instanceof Error ? scrubSecrets(error.message) : String(error),
      };
    }
  }

  /**
   * Sends a minimal real completion to prove the credentials and the model both
   * work. This is the only trustworthy readiness signal.
   */
  async verifyChat(model: string): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      await this.chat({
        model,
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 1,
        temperature: 0,
      });
      return {
        ok: true,
        baseUrl: this.baseUrl,
        latencyMs: Date.now() - startedAt,
        authVerified: true,
      };
    } catch (error) {
      return {
        ok: false,
        baseUrl: this.baseUrl,
        latencyMs: Date.now() - startedAt,
        authVerified: false,
        error: error instanceof Error ? scrubSecrets(error.message) : String(error),
      };
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
