/**
 * Dashboard formatting + secret-exposure tests.
 *
 * Two guarantees are pinned here:
 *   1. no percentage/progress is ever synthesised — durations come from real
 *      timestamps and nothing else;
 *   2. nothing the dashboard renders can leak a credential, because the same
 *      redaction layer used on the way into the database is applied to the
 *      payloads the API serves.
 */

import { describe, expect, it } from "vitest";

import {
  formatDuration,
  formatElapsedFrom,
  formatRelative,
  prettyJson,
  truncate,
} from "../../app/lib/utils.js";
import { redact } from "../../src/persistence/redaction.js";
import { scrubSecrets } from "../../src/domain/errors.js";

describe("formatDuration", () => {
  it("formats real elapsed time only", () => {
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_600_000)).toBe("1h 0m");
  });

  it("returns a placeholder rather than guessing when there is no value", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("formatElapsedFrom", () => {
  it("computes elapsed time from a start timestamp", () => {
    const start = "2026-09-12T21:00:00.000Z";
    const now = Date.parse("2026-09-12T21:00:42.000Z");
    expect(formatElapsedFrom(start, now)).toBe("42s");
  });

  it("handles a missing or invalid timestamp", () => {
    expect(formatElapsedFrom(undefined)).toBe("—");
    expect(formatElapsedFrom("not-a-date")).toBe("—");
  });
});

describe("formatRelative", () => {
  const base = Date.parse("2026-09-12T21:00:00.000Z");

  it("describes recent timestamps", () => {
    expect(formatRelative("2026-09-12T20:59:58.000Z", base)).toBe("just now");
    expect(formatRelative("2026-09-12T20:59:10.000Z", base)).toBe("50s ago");
    expect(formatRelative("2026-09-12T20:10:00.000Z", base)).toBe("50m ago");
    expect(formatRelative("2026-09-12T18:00:00.000Z", base)).toBe("3h ago");
  });

  it("never reports a negative age", () => {
    expect(formatRelative("2026-09-12T21:00:30.000Z", base)).toBe("just now");
  });
});

describe("truncate and prettyJson", () => {
  it("bounds long strings", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("pretty-prints a payload and survives a circular value", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof prettyJson(circular)).toBe("string");
  });
});

describe("secret exposure", () => {
  it("redacts credential-shaped keys in a rendered payload", () => {
    const redacted = redact({
      ROUTER_API_KEY: "sk-live-abcdef0123456789",
      apiKey: "sk-live-abcdef0123456789",
      authorization: "Bearer sk-live-abcdef0123456789",
      nested: { password: "hunter2", token: "tok_abcdefghijklmno" },
    }) as Record<string, unknown>;

    const rendered = prettyJson(redacted);
    expect(rendered).not.toContain("sk-live-abcdef0123456789");
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain("tok_abcdefghijklmno");
    expect(rendered).toContain("[REDACTED]");
  });

  it("keeps non-sensitive diagnostic fields readable", () => {
    const redacted = redact({
      apiKeySource: "env",
      model: "grip/deepseek-v4.1-flash",
      tool: "run_command",
    }) as Record<string, unknown>;

    expect(redacted.apiKeySource).toBe("env");
    expect(redacted.model).toBe("grip/deepseek-v4.1-flash");
    expect(redacted.tool).toBe("run_command");
  });

  it("scrubs an api key embedded in free-form command output", () => {
    const scrubbed = scrubSecrets(
      "curl -H 'Authorization: Bearer sk-live-abcdef0123456789' http://localhost:20128/v1/models",
    );
    expect(scrubbed).not.toContain("sk-live-abcdef0123456789");
  });
});
