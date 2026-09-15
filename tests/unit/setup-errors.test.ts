/**
 * Phase 1 — setup failure classification tests.
 *
 * The setup wizard must never show a stack trace. These tests pin the small,
 * stable label vocabulary layered on top of the existing error taxonomy.
 */

import { describe, expect, it } from "vitest";

import {
  RouterError,
  classifySetupFailure,
  describeSetupLabel,
  isValidHttpUrl,
  setupLabelForKind,
  type ErrorKind,
} from "../../src/domain/errors.js";

describe("isValidHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isValidHttpUrl("http://localhost:20128/v1")).toBe(true);
    expect(isValidHttpUrl("https://router.example.com/v1")).toBe(true);
  });

  it("rejects non-http protocols and garbage", () => {
    expect(isValidHttpUrl("ftp://host/v1")).toBe(false);
    expect(isValidHttpUrl("not-a-url")).toBe(false);
    expect(isValidHttpUrl("")).toBe(false);
  });
});

describe("setupLabelForKind", () => {
  const cases: ReadonlyArray<[ErrorKind, ReturnType<typeof setupLabelForKind>]> = [
    ["authentication", "INVALID_API_KEY"],
    ["network", "ROUTER_UNREACHABLE"],
    ["timeout", "TIMEOUT"],
    ["server-error", "SERVER_ERROR"],
    ["rate-limit", "SERVER_ERROR"],
    ["not-found", "MODEL_NOT_FOUND"],
    ["validation", "INVALID_URL"],
    ["parse", "UNKNOWN"],
    ["unknown", "UNKNOWN"],
  ];

  it.each(cases)("maps %s -> %s", (kind, label) => {
    expect(setupLabelForKind(kind)).toBe(label);
  });
});

describe("classifySetupFailure", () => {
  it("reports INVALID_URL for a malformed base URL before anything else", () => {
    const result = classifySetupFailure(new Error("boom"), { baseUrl: "not-a-url" });
    expect(result.label).toBe("INVALID_URL");
  });

  it("classifies a RouterError by its kind", () => {
    const error = new RouterError("unauthorized", { kind: "authentication" });
    expect(classifySetupFailure(error).label).toBe("INVALID_API_KEY");
  });

  it("classifies a socket error as ROUTER_UNREACHABLE", () => {
    const error = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    expect(classifySetupFailure(error).label).toBe("ROUTER_UNREACHABLE");
  });

  it("classifies an abort as TIMEOUT", () => {
    const error = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifySetupFailure(error).label).toBe("TIMEOUT");
  });

  it("returns a human message and never the raw error text", () => {
    const error = new Error("secret-looking-internal-detail sk-live-abcdef");
    const result = classifySetupFailure(error);
    expect(result.message).not.toContain("sk-live");
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("describeSetupLabel", () => {
  it("returns a non-empty message for every label", () => {
    for (const label of [
      "INVALID_URL",
      "ROUTER_UNREACHABLE",
      "INVALID_API_KEY",
      "TIMEOUT",
      "SERVER_ERROR",
      "MODEL_NOT_FOUND",
      "UNKNOWN",
    ] as const) {
      expect(describeSetupLabel(label).length).toBeGreaterThan(0);
    }
  });
});
