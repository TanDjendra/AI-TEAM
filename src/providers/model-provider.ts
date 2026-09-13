/**
 * Provider abstraction.
 *
 * The orchestrator and the agents only ever see `ModelProvider`. Swapping
 * 9Router for another gateway means writing another implementation of this
 * interface and changing configuration — no agent or orchestrator edit.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * Native function-calling specification, in the OpenAI wire format that 9Router
 * accepts (verified: the router returns `finish_reason: "tool_calls"` with
 * `message.tool_calls[]` for both `grip/deepseek-v4.1-flash` and
 * `grip/gpt-5.6-luna`).
 */
export interface ModelToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** A single tool call requested by the model, normalised. */
export interface ModelToolCall {
  id: string;
  name: string;
  /** Arguments exactly as the model emitted them (usually a JSON string). */
  argumentsRaw: string;
  /** Parsed arguments. Undefined when `argumentsRaw` was not valid JSON. */
  args?: Record<string, unknown>;
  /** Set when `argumentsRaw` could not be parsed; fed back to the model. */
  parseError?: string;
}

export interface ModelMessage {
  role: ChatRole;
  content: string;
  /** Set on an assistant message that requested tools. */
  toolCalls?: ModelToolCall[];
  /** Set on a `tool` message, linking the result to its request. */
  toolCallId?: string;
  /** Set when the tool call could not be parsed (native path bookkeeping). */
  toolName?: string;
}

export interface ModelRequest {
  /** Provider-qualified model id, e.g. "grip/deepseek-v4.1-flash". */
  model: string;
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Request a JSON-object response from the gateway. */
  json?: boolean;
  /** Native tool definitions. Omit for text-only turns. */
  tools?: ModelToolSpec[];
  /** "auto" lets the model decide; "none" forbids tool calls (final answer). */
  toolChoice?: "auto" | "none";
  /** Correlation id used in logs. Generated when omitted. */
  requestId?: string;
  /** Caller cancellation, combined with the provider timeout. */
  signal?: AbortSignal;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelResponse {
  /** Provider response id (9Router passes the upstream id through). */
  id: string;
  /** Model the gateway reports as having served the request. */
  resolvedModel: string;
  requestedModel: string;
  content: string;
  finishReason: string;
  usage: ModelUsage;
  latencyMs: number;
  /** How many HTTP attempts it took (1 for a first-try success). */
  attempts: number;
  /**
   * Tool calls requested by the model. Empty/absent means the model produced a
   * final text answer for this turn.
   */
  toolCalls?: ModelToolCall[];
}

export interface ProviderHealth {
  ok: boolean;
  baseUrl: string;
  latencyMs: number;
  modelCount?: number;
  /**
   * IMPORTANT: `ok` reflects *reachability and model listing only*. On 9Router
   * GET /v1/models is served WITHOUT authentication, so a healthy result does not
   * prove the credentials work. Use `verifyChat()` (or a real completion) before
   * concluding that a key is valid.
   */
  authVerified?: boolean;
  error?: string;
}

export interface ChatStreamChunk {
  delta: string;
  done: boolean;
}

export interface ModelMetadata {
  contextWindow?: number;
  maxOutput?: number;
}

export interface ModelProvider {
  /** Short provider id used in logs, e.g. "9router". */
  readonly id: string;
  readonly baseUrl: string;

  chat(input: ModelRequest): Promise<ModelResponse>;

  /** Incremental deltas, ending with a final chunk where `done` is true. */
  chatStream(input: ModelRequest): AsyncGenerator<ChatStreamChunk, ModelResponse, void>;

  /** Model ids advertised by the gateway. Used for startup verification. */
  listModels(): Promise<string[]>;

  /** Retrieves metadata for a specific model, if available. */
  getModelMetadata?(model: string): Promise<ModelMetadata | undefined>;

  health(): Promise<ProviderHealth>;

  /**
   * Proves that the credentials actually work by issuing a minimal real
   * completion. Optional because a cheap reachability probe is not always
   * possible, but required before claiming a provider is *ready* — on 9Router,
   * `health()` alone passes even with a missing key.
   */
  verifyChat?(model: string): Promise<ProviderHealth>;
}
