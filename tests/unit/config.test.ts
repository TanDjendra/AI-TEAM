import { describe, expect, it } from "vitest";

import {
  ConfigError,
  describeConfig,
  loadConfig,
  parseDotEnv,
  readRouterCliSecret,
} from "../../src/config/env.js";

const BASE_ENV = {
  ROUTER_BASE_URL: "http://localhost:20128/v1",
  ROUTER_API_KEY: "test-key-not-a-real-secret",
  CODER_MODEL: "grip/deepseek-v4.1-flash",
  REVIEWER_MODEL: "grip/gpt-5.6-luna",
};

function load(env: Record<string, string | undefined>, cwd = process.cwd()) {
  return loadConfig({ env, cwd, loadDotEnv: false });
}

describe("parseDotEnv", () => {
  it("parses keys, values, comments and quotes", () => {
    const parsed = parseDotEnv(
      [
        "# a comment",
        "APP_ENV=development",
        "",
        'ROUTER_BASE_URL="http://localhost:20128/v1"',
        "CODER_MODEL='grip/deepseek-v4.1-flash'",
        "LOG_LEVEL=info # trailing comment",
      ].join("\n"),
    );

    expect(parsed.APP_ENV).toBe("development");
    expect(parsed.ROUTER_BASE_URL).toBe("http://localhost:20128/v1");
    expect(parsed.CODER_MODEL).toBe("grip/deepseek-v4.1-flash");
    expect(parsed.LOG_LEVEL).toBe("info");
  });
});

describe("loadConfig", () => {
  it("loads the 9Router configuration from the environment", () => {
    const config = load(BASE_ENV);

    expect(config.router.baseUrl).toBe("http://localhost:20128/v1");
    expect(config.router.apiKey).toBe("test-key-not-a-real-secret");
    expect(config.router.apiKeySource).toBe("env");
    expect(config.coder.model).toBe("grip/deepseek-v4.1-flash");
    expect(config.reviewer.model).toBe("grip/gpt-5.6-luna");
    expect(config.orchestrator.maxReviewCycles).toBe(3);
    expect(config.logging.level).toBe("info");
  });
  it("strips a trailing slash from the base URL", () => {
    const config = load({ ...BASE_ENV, ROUTER_BASE_URL: "http://localhost:20128/v1/" });
    expect(config.router.baseUrl).toBe("http://localhost:20128/v1");
  });

  it("never reads a model id from a hard-coded default", () => {
    const config = load(BASE_ENV);
    expect(() => load({ ...BASE_ENV, CODER_MODEL: undefined })).toThrowError(ConfigError);
    expect(config.coder.model).not.toBe(config.reviewer.model);
  });

  it("rejects a missing CODER_MODEL with an actionable message", () => {
    try {
      load({ ...BASE_ENV, CODER_MODEL: undefined });
      expect.unreachable("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).fields.join(" ")).toContain("CODER_MODEL");
    }
  });

  it("rejects a missing REVIEWER_MODEL", () => {
    expect(() => load({ ...BASE_ENV, REVIEWER_MODEL: "" })).toThrowError(/REVIEWER_MODEL/);
  });

  it("refuses identical coder and reviewer models", () => {
    expect(() =>
      load({ ...BASE_ENV, REVIEWER_MODEL: "grip/deepseek-v4.1-flash" }),
    ).toThrowError(/must differ/);
  });

  it("requires an API key, even for a local router", () => {
    // A local router is not an excuse to skip the key: /v1/models does not
    // enforce auth, so a missing key would only fail later, mid-run.
    expect(() => load({ ...BASE_ENV, ROUTER_API_KEY: "" })).toThrowError(/ROUTER_API_KEY is required/);
    expect(() =>
      load({ ...BASE_ENV, ROUTER_API_KEY: undefined, ROUTER_BASE_URL: "https://router.example.com/v1" }),
    ).toThrowError(/ROUTER_API_KEY is required/);
  });

  it("never falls back to a secret file on disk", () => {
    // The 9Router CLI secret is rejected (401) by /v1/chat/completions, so a
    // silent fallback would produce confusing mid-run failures.
    const env = { ...BASE_ENV, ROUTER_API_KEY: "", APPDATA: process.env.APPDATA ?? "" };
    expect(() => load(env)).toThrowError(/ROUTER_API_KEY is required/);
    expect(readRouterCliSecret()).toBeUndefined();
  });

  it("validates the base URL", () => {
    expect(() => load({ ...BASE_ENV, ROUTER_BASE_URL: "not-a-url" })).toThrowError(/ROUTER_BASE_URL/);
    expect(() => load({ ...BASE_ENV, ROUTER_BASE_URL: "ftp://host/v1" })).toThrowError(
      /http\(s\) URL/,
    );
  });

  it("validates numeric limits", () => {
    expect(() => load({ ...BASE_ENV, ROUTER_TIMEOUT_MS: "abc" })).toThrowError(/ROUTER_TIMEOUT_MS/);
    expect(() => load({ ...BASE_ENV, MAX_REVIEW_CYCLES: "0" })).toThrowError(/MAX_REVIEW_CYCLES/);
    expect(load({ ...BASE_ENV, MAX_REVIEW_CYCLES: "5" }).orchestrator.maxReviewCycles).toBe(5);
    expect(load({ ...BASE_ENV, ROUTER_MAX_RETRIES: "0" }).router.maxRetries).toBe(0);
  });

  it("validates the log level and format", () => {
    expect(() => load({ ...BASE_ENV, LOG_LEVEL: "verbose" })).toThrowError(/LOG_LEVEL/);
    expect(() => load({ ...BASE_ENV, LOG_FORMAT: "xml" })).toThrowError(/LOG_FORMAT/);
    expect(load({ ...BASE_ENV, LOG_FORMAT: "json" }).logging.format).toBe("json");
  });

  it("reports every problem at once", () => {
    try {
      load({ LOG_LEVEL: "nope", LOG_FORMAT: "xml" });
      expect.unreachable("expected ConfigError");
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError.fields.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("accepts several problems at once", () => {
    try {
      load({ LOG_LEVEL: "nope", LOG_FORMAT: "xml" });
      expect.unreachable("expected ConfigError");
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError.fields.length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("describeConfig", () => {
  it("never leaks the API key", () => {
    const config = load(BASE_ENV);
    const described = describeConfig(config);
    const serialised = JSON.stringify(described);

    expect(serialised).not.toContain("test-key-not-a-real-secret");
    expect(described["router.apiKey"]).toBe("[configured]");
    expect(described["router.baseUrl"]).toBe("http://localhost:20128/v1");
    expect(described["coder.model"]).toBe("grip/deepseek-v4.1-flash");
    expect(described["reviewer.model"]).toBe("grip/gpt-5.6-luna");
  });

  it("reports a missing key without inventing one", () => {
    const described = describeConfig({
      ...load(BASE_ENV),
      router: { ...load(BASE_ENV).router, apiKey: "" },
    });
    expect(described["router.apiKey"]).toBe("[missing]");
  });
});
