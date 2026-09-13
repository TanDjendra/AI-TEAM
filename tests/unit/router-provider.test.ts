import { describe, expect, it, vi } from "vitest";

import { RouterError } from "../../src/domain/errors.js";
import {
  RouterProvider,
  parseChatResponse,
  stripTrailingSseFrames,
} from "../../src/providers/router-provider.js";

const BASE = "http://localhost:20128/v1";

function jsonResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function sseResponse(frames: string[]) {
  const body = frames.map((frame) => `data: ${frame}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const NON_STREAM_BODY = JSON.stringify({
  id: "cmb-1",
  object: "chat.completion",
  model: "deepseek-v4.1-flash",
  choices: [{ index: 0, message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 789, completion_tokens: 6, total_tokens: 795 },
});

describe("stripTrailingSseFrames", () => {
  it("removes the trailing data: [DONE] that 9Router appends to non-stream responses", () => {
    const body = `${NON_STREAM_BODY}data: [DONE]\n\n`;
    const stripped = stripTrailingSseFrames(body);
    expect(stripped).toBe(NON_STREAM_BODY);
    expect(() => JSON.parse(stripped)).not.toThrow();
  });

  it("keeps a payload that legitimately contains the text 'data:'", () => {
    const payload = JSON.stringify({
      choices: [{ message: { content: "use data: [DONE] as the terminator" } }],
    });
    expect(stripTrailingSseFrames(payload)).toBe(payload);
  });

  it("returns a plain body unchanged", () => {
    expect(stripTrailingSseFrames(NON_STREAM_BODY)).toBe(NON_STREAM_BODY);
  });
});

describe("parseChatResponse", () => {
  it("parses a real 9Router non-stream response body", () => {
    const response = parseChatResponse(`${NON_STREAM_BODY}data: [DONE]\n\n`, "grip/deepseek-v4.1-flash", 12, 1);

    expect(response.content).toBe("PONG");
    expect(response.resolvedModel).toBe("deepseek-v4.1-flash");
    expect(response.requestedModel).toBe("grip/deepseek-v4.1-flash");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toMatchObject({ promptTokens: 789, completionTokens: 6, totalTokens: 795 });
    expect(response.attempts).toBe(1);
  });

  it("raises a parse error for a non-JSON body", () => {
    expect(() => parseChatResponse("<html>502</html>", "m", 1, 1)).toThrowError(RouterError);
  });

  it("raises a parse error when there are no choices", () => {
    expect(() => parseChatResponse(JSON.stringify({ id: "x" }), "m", 1, 1)).toThrowError(/no choices/);
  });
});

describe("RouterProvider.chat", () => {
  it("posts to /chat/completions with a bearer token and parses the answer", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(`${NON_STREAM_BODY}data: [DONE]\n\n`));
    const provider = new RouterProvider({ baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await provider.chat({
      model: "grip/deepseek-v4.1-flash",
      messages: [{ role: "user", content: "ping" }],
      json: true,
      maxTokens: 50,
    });

    expect(response.content).toBe("PONG");
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/chat/completions`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("grip/deepseek-v4.1-flash");
    expect(body.stream).toBe(false);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(50);
  });

  it("retries a retryable 429 and succeeds on the second attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(NON_STREAM_BODY));

    const provider = new RouterProvider({
      baseUrl: BASE,
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    });

    const response = await provider.chat({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(response.attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 and surfaces an authentication error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("unauthorized", { status: 401 }));
    const provider = new RouterProvider({
      baseUrl: BASE,
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 3,
      retryBaseDelayMs: 1,
    });

    await expect(
      provider.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "authentication", status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries on a persistent 500", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse("boom", { status: 500 }));
    const provider = new RouterProvider({
      baseUrl: BASE,
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    });

    await expect(
      provider.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "server-error" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("normalises a connection refusal into a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:20128"), { code: "ECONNREFUSED" });
    });
    const provider = new RouterProvider({
      baseUrl: BASE,
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 1,
      retryBaseDelayMs: 1,
    });

    await expect(
      provider.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ kind: "network" });
  });

  it("refuses to be constructed without an API key", () => {
    expect(() => new RouterProvider({ baseUrl: BASE, apiKey: "" })).toThrowError(/API key/);
  });
});

describe("RouterProvider.chatStream", () => {
  it("yields deltas and returns the accumulated content", async () => {
    const frames = [
      JSON.stringify({ id: "1", model: "deepseek-v4.1-flash", choices: [{ delta: { content: "1" } }] }),
      JSON.stringify({ id: "1", model: "deepseek-v4.1-flash", choices: [{ delta: { content: " 2" } }] }),
      JSON.stringify({ id: "1", model: "deepseek-v4.1-flash", choices: [{ delta: {}, finish_reason: "stop" }] }),
      "[DONE]",
    ];
    const fetchImpl = vi.fn(async () => sseResponse(frames));
    const provider = new RouterProvider({ baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    const deltas: string[] = [];
    const iterator = provider.chatStream({ model: "grip/deepseek-v4.1-flash", messages: [{ role: "user", content: "x" }] });

    let step = await iterator.next();
    while (!step.done) {
      if (step.value.delta) deltas.push(step.value.delta);
      step = await iterator.next();
    }

    expect(deltas).toEqual(["1", " 2"]);
    expect(step.value.content).toBe("1 2");
    expect(step.value.finishReason).toBe("stop");
  });
});

describe("RouterProvider.listModels", () => {
  it("reads the model catalog from /models", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        JSON.stringify({
          object: "list",
          data: [{ id: "grip/deepseek-v4.1-flash" }, { id: "grip/gpt-5.6-luna" }],
        }),
      ),
    );
    const provider = new RouterProvider({ baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(provider.listModels()).resolves.toEqual([
      "grip/deepseek-v4.1-flash",
      "grip/gpt-5.6-luna",
    ]);
    const [url] = fetchImpl.mock.calls[0]! as unknown as [string];
    expect(url).toBe(`${BASE}/models`);
  });

  it("reports a failed health check without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    const provider = new RouterProvider({
      baseUrl: BASE,
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });

    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.error).toContain("unreachable");
    // /v1/models is unauthenticated on 9Router: a healthy result proves nothing
    // about the credentials.
    expect(health.authVerified).toBe(false);
  });
});

describe("RouterProvider native tool calling", () => {
  const TOOL_CALL_BODY = JSON.stringify({
    id: "cmb-tools",
    model: "deepseek-v4.1-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "I'll inspect the workspace as requested.",
          tool_calls: [
            {
              id: "call_00_abc",
              type: "function",
              function: { name: "run_command", arguments: '{"command": "ls -la"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 397, completion_tokens: 46, total_tokens: 443 },
  });

  it("sends native tool definitions and reads tool_calls back", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(TOOL_CALL_BODY));
    const provider = new RouterProvider({ baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await provider.chat({
      model: "grip/deepseek-v4.1-flash",
      messages: [{ role: "user", content: "do the task" }],
      tools: [
        {
          type: "function",
          function: {
            name: "run_command",
            description: "Run a command",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          },
        },
      ],
    });

    // The request really carried the tool schema.
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.tool_choice).toBe("auto");
    expect((body.tools as unknown[]).length).toBe(1);

    // And the response's tool call was surfaced, parsed and normalised.
    expect(response.finishReason).toBe("tool_calls");
    expect(response.content).toBe("I'll inspect the workspace as requested.");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0]?.id).toBe("call_00_abc");
    expect(response.toolCalls?.[0]?.name).toBe("run_command");
    expect(response.toolCalls?.[0]?.args).toEqual({ command: "ls -la" });
  });

  it("accepts a tool-calling turn whose content is null", async () => {
    const body = JSON.stringify({
      id: "x",
      model: "gpt-5.6-luna",
      choices: [
        {
          message: { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "list_files", arguments: "{}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const provider = new RouterProvider({ baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await provider.chat({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(response.content).toBe("");
    expect(response.toolCalls?.[0]?.name).toBe("list_files");
    expect(response.toolCalls?.[0]?.args).toEqual({});
  });

  it("preserves a malformed arguments payload instead of dropping the call", async () => {
    const body = JSON.stringify({
      id: "x",
      choices: [
        {
          message: { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "write_file", arguments: '{"path": ' } }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const provider = new RouterProvider({ baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    const response = await provider.chat({ model: "m", messages: [{ role: "user", content: "x" }] });
    const call = response.toolCalls?.[0];
    expect(call?.name).toBe("write_file");
    expect(call?.args).toBeUndefined();
    expect(call?.parseError).toBeTruthy();
    expect(call?.argumentsRaw).toBe('{"path": ');
  });

  it("serialises assistant tool_calls and tool results into the wire shape", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify({ id: "x", choices: [{ message: { content: "done" }, finish_reason: "stop" }] })),
    );
    const provider = new RouterProvider({ baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    await provider.chat({
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: "calling",
          toolCalls: [{ id: "c1", name: "run_command", argumentsRaw: '{"command":"ls"}' }],
        },
        { role: "tool", content: "exit_code: 0", toolCallId: "c1", toolName: "run_command" },
      ],
    });

    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<Record<string, unknown>> };

    const assistant = body.messages.find((message) => message.role === "assistant");
    expect(assistant?.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "run_command", arguments: '{"command":"ls"}' } },
    ]);

    const toolMessage = body.messages.find((message) => message.role === "tool");
    expect(toolMessage).toEqual({ role: "tool", tool_call_id: "c1", content: "exit_code: 0" });
  });

  it("does not send response_format together with tools", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(TOOL_CALL_BODY));
    const provider = new RouterProvider({ baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    await provider.chat({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      json: true,
      tools: [{ type: "function", function: { name: "t", description: "", parameters: {} } }],
    });

    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.response_format).toBeUndefined();
    expect(body.tools).toBeDefined();
  });

  it("forbids tool calls when tool_choice is none (forced final answer)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(JSON.stringify({ id: "x", choices: [{ message: { content: "{}" }, finish_reason: "stop" }] })),
    );
    const provider = new RouterProvider({ baseUrl: BASE, apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    await provider.chat({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      toolChoice: "none",
    });

    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.tool_choice).toBe("none");
  });
});
