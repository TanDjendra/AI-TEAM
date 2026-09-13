import { describe, expect, it } from "vitest";

import {
  OUTPUT_SUMMARY_MAX,
  redact,
  redactArguments,
  redactToJson,
  summarize,
  summarizeOutput,
} from "../../src/persistence/redaction.js";

describe("redaction", () => {
  it("removes credential-shaped keys at the top level", () => {
    const redacted = redact({
      command: "curl",
      apiKey: "sk-live-abcdef1234567890",
      authorization: "Bearer sk-live-abcdef1234567890",
      password: "hunter2",
      cookie: "session=abc",
    }) as Record<string, unknown>;

    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.cookie).toBe("[REDACTED]");
    expect(redacted.command).toBe("curl");
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
  });

  it("removes nested credential-shaped keys", () => {
    const redacted = redact({
      outer: { inner: { token: "grip-0123456789abcdef", keep: "yes" } },
    }) as { outer: { inner: Record<string, unknown> } };

    expect(redacted.outer.inner.token).toBe("[REDACTED]");
    expect(redacted.outer.inner.keep).toBe("yes");
  });

  it("scrubs a credential that appears inside a normal string value", () => {
    const redacted = redact({ note: "the key is sk-live-abcdef1234567890 ok" }) as {
      note: string;
    };
    expect(redacted.note).not.toContain("sk-live-abcdef1234567890");
    expect(redacted.note).toContain("[REDACTED]");
  });

  it("scrubs dynamic environment secrets if loaded", () => {
    process.env.ROUTER_API_KEY = "super-secret-dynamic-key";
    const redacted = redact({ note: "the key is super-secret-dynamic-key ok" }) as { note: string };
    expect(redacted.note).not.toContain("super-secret-dynamic-key");
    expect(redacted.note).toContain("[REDACTED]");
  });

  it("omits large payload bodies instead of storing them", () => {
    const body = "x".repeat(10_000);
    const redacted = redact({ path: "a.js", content: body }) as Record<string, unknown>;
    expect(redacted.content).toBe(`[omitted ${body.length} chars]`);
    expect(JSON.stringify(redacted).length).toBeLessThan(200);
  });

  it("bounds long strings", () => {
    const redacted = redact({ note: "y".repeat(10_000) }, { maxStringLength: 50 }) as {
      note: string;
    };
    expect(redacted.note.length).toBeLessThan(100);
    expect(redacted.note).toContain("+9950 chars");
  });

  it("bounds arrays", () => {
    const redacted = redact({ list: Array.from({ length: 500 }, (_, i) => i) }) as {
      list: unknown[];
    };
    expect(redacted.list.length).toBeLessThanOrEqual(101);
    expect(String(redacted.list.at(-1))).toContain("more");
  });

  it("bounds nesting depth", () => {
    let deep: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    const redacted = redact(deep) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).toContain("[depth-limit]");
  });

  it("does not crash on a circular structure", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const redacted = redact(circular) as Record<string, unknown>;
    expect(redacted.self).toBe("[circular]");
  });

  it("serialises an Error without a stack trace", () => {
    const redacted = redact({ error: new Error("boom") }) as {
      error: { name: string; message: string };
    };
    expect(redacted.error.name).toBe("Error");
    expect(redacted.error.message).toBe("boom");
    expect(JSON.stringify(redacted)).not.toContain("at ");
  });

  it("redactToJson produces parseable output", () => {
    const json = redactToJson({ apiKey: "sk-live-abcdef1234567890", command: "ls" });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.apiKey).toBe("[REDACTED]");
    expect(parsed.command).toBe("ls");
  });

  it("reports whether redactArguments changed anything", () => {
    const unchanged = redactArguments({ command: "npm test" });
    expect(unchanged.redacted).toBe(false);

    const changed = redactArguments({ command: "npm test", apiKey: "sk-live-abcdef1234567890" });
    expect(changed.redacted).toBe(true);
    expect(changed.value.apiKey).toBe("[REDACTED]");
  });
});

describe("output summarisation", () => {
  it("keeps short output intact", () => {
    expect(summarizeOutput("# pass 3")).toBe("# pass 3");
  });

  it("bounds long output but keeps the head and the tail", () => {
    const output = `${"h".repeat(5_000)}MIDDLE${"t".repeat(5_000)}`;
    const summary = summarizeOutput(output);

    expect(summary.length).toBeLessThanOrEqual(OUTPUT_SUMMARY_MAX + 100);
    expect(summary).toContain("omitted");
    expect(summary.startsWith("h")).toBe(true);
    expect(summary.endsWith("t")).toBe(true);
  });

  it("scrubs secrets out of output", () => {
    const summary = summarizeOutput("using Bearer sk-live-abcdef1234567890");
    expect(summary).not.toContain("sk-live-abcdef1234567890");
    expect(summary).toContain("[REDACTED]");
  });

  it("normalises CRLF and trims", () => {
    expect(summarizeOutput("  a\r\nb  ")).toBe("a\nb");
  });

  it("summarize collapses whitespace and bounds length", () => {
    expect(summarize("a\n\n  b")).toBe("a b");
    expect(summarize("z".repeat(1_000), 50).length).toBeLessThanOrEqual(60);
  });
});
