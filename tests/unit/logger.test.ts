import { describe, expect, it } from "vitest";

import { createLogger, type LogRecord } from "../../src/domain/logger.js";
import {
  RouterError,
  classifyHttpStatus,
  scrubSecrets,
  toRouterError,
} from "../../src/domain/errors.js";

function capture(level: "debug" | "info" | "warn" | "error" = "debug") {
  const lines: string[] = [];
  const logger = createLogger({ level, format: "json", sink: (line) => lines.push(line) });
  return { logger, lines, parsed: (): LogRecord[] => lines.map((line) => JSON.parse(line) as LogRecord) };
}

describe("structured logging", () => {
  it("emits one JSON object per line with time, level and event", () => {
    const { logger, parsed } = capture();
    logger.info("run.start", { taskId: "TASK-001" });

    const [record] = parsed();
    expect(record).toBeDefined();
    expect(record!.level).toBe("info");
    expect(record!.event).toBe("run.start");
    expect(record!.taskId).toBe("TASK-001");
    expect(typeof record!.time).toBe("string");
    expect(new Date(record!.time).toString()).not.toBe("Invalid Date");
  });

  it("filters below the configured level", () => {
    const { logger, parsed } = capture("warn");
    logger.debug("noisy.detail");
    logger.info("also.noisy");
    logger.warn("worth.seeing");
    logger.error("definitely");

    expect(parsed().map((record) => record.event)).toEqual(["worth.seeing", "definitely"]);
  });

  it("merges child fields and still records from the root", () => {
    const { logger, parsed } = capture();
    const child = logger.child({ taskId: "TASK-002", agent: "coder" });
    child.info("agent.start", { attempt: 1 });

    const record = parsed().find((entry) => entry.event === "agent.start");
    expect(record?.taskId).toBe("TASK-002");
    expect(record?.agent).toBe("coder");
    expect(record?.attempt).toBe(1);
    expect(logger.records().length).toBeGreaterThan(0);
  });

  it("redacts credential-shaped values", () => {
    const { logger, parsed } = capture();
    logger.info("auth", {
      authorization: "Bearer sk-live-abcdef1234567890",
      apiKey: "grip-0123456789abcdef",
      note: "the key is sk-live-abcdef1234567890",
    });

    const record = parsed()[0]!;
    expect(record.authorization).toBe("[REDACTED]");
    expect(record.apiKey).toBe("[REDACTED]");
    expect(JSON.stringify(record)).not.toContain("sk-live-abcdef1234567890");
  });

  it("redacts nested sensitive keys", () => {
    const { logger, parsed } = capture();
    logger.info("config.loaded", {
      router: { baseUrl: "http://localhost:20128/v1", apiKey: "super-secret-value" },
    });

    const record = parsed()[0]! as unknown as { router: { apiKey: string; baseUrl: string } };
    expect(record.router.apiKey).toBe("[REDACTED]");
    expect(record.router.baseUrl).toBe("http://localhost:20128/v1");
  });

  it("serialises errors into structured fields instead of a stack dump", () => {
    const { logger, parsed } = capture();
    logger.error("agent.error", { error: new Error("connection refused") });

    const record = parsed()[0]! as unknown as { error: { name: string; message: string } };
    expect(record.error.name).toBe("Error");
    expect(record.error.message).toBe("connection refused");
    expect(JSON.stringify(record)).not.toContain("at ");
  });

  it("renders readable text output when asked", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", format: "text", sink: (line) => lines.push(line) });
    logger.info("state.transition", { from: "REVIEW", to: "REJECTED" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("state.transition");
    expect(lines[0]).toContain("from=REVIEW");
    expect(lines[0]).toContain("to=REJECTED");
  });
});

describe("error taxonomy", () => {
  it("classifies HTTP statuses", () => {
    expect(classifyHttpStatus(401)).toBe("authentication");
    expect(classifyHttpStatus(403)).toBe("authentication");
    expect(classifyHttpStatus(404)).toBe("not-found");
    expect(classifyHttpStatus(408)).toBe("timeout");
    expect(classifyHttpStatus(429)).toBe("rate-limit");
    expect(classifyHttpStatus(500)).toBe("server-error");
    expect(classifyHttpStatus(503)).toBe("server-error");
    expect(classifyHttpStatus(400)).toBe("validation");
  });

  it("marks only transient kinds as retryable", () => {
    expect(new RouterError("x", { kind: "rate-limit" }).retryable).toBe(true);
    expect(new RouterError("x", { kind: "server-error" }).retryable).toBe(true);
    expect(new RouterError("x", { kind: "timeout" }).retryable).toBe(true);
    expect(new RouterError("x", { kind: "network" }).retryable).toBe(true);
    expect(new RouterError("x", { kind: "authentication" }).retryable).toBe(false);
    expect(new RouterError("x", { kind: "validation" }).retryable).toBe(false);
    expect(new RouterError("x", { kind: "parse" }).retryable).toBe(false);
  });

  it("normalises an AbortError into a timeout", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const normalised = toRouterError(abort, { url: "http://localhost:20128/v1/chat/completions" });

    expect(normalised).toBeInstanceOf(RouterError);
    expect(normalised.kind).toBe("timeout");
    expect(normalised.message).toContain("timed out");
  });

  it("normalises a connection refusal into a network error with a hint", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:20128"), {
      code: "ECONNREFUSED",
    });
    const normalised = toRouterError(refused);

    expect(normalised.kind).toBe("network");
    expect(normalised.message).toContain("unreachable");
  });

  it("passes an existing RouterError through untouched", () => {
    const original = new RouterError("already normalised", { kind: "validation" });
    expect(toRouterError(original)).toBe(original);
  });

  it("scrubs secrets out of arbitrary text", () => {
    expect(scrubSecrets("Authorization: Bearer sk-live-abcdef1234567890")).not.toContain(
      "sk-live-abcdef1234567890",
    );
    expect(scrubSecrets('{"api_key":"grip-0123456789abcdef"}')).not.toContain("grip-0123456789abcdef");
    expect(scrubSecrets("nothing sensitive here")).toBe("nothing sensitive here");
  });
});
