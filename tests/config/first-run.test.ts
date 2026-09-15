/**
 * Phase 1 — first-run detection & configuration readiness tests.
 *
 * The point of these tests is that readiness is NOT "does a file exist". A file
 * can exist and be broken (ConfigFileError), or be valid JSON yet still miss the
 * API key / models. `assessConfiguration` must report exactly what `loadConfig`
 * would do at startup.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assessConfiguration,
  hasValidConfiguration,
  isFirstRun,
} from "../../src/config/env.js";
import { writeConfigFile, type AiTeamConfigFile } from "../../src/config/config-file.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-team-firstrun-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID_FILE: AiTeamConfigFile = {
  version: 1,
  models: { coder: "grip/deepseek-v4.1-flash", reviewer: "grip/gpt-5.6-luna" },
  catalog: [],
  roles: [],
};

function configPath(): string {
  return join(dir, "ai-team.config.json");
}

function assess(env: Record<string, string | undefined>) {
  return assessConfiguration({ env, cwd: dir, loadDotEnv: false, configPath: configPath() });
}

const FULL_ENV = {
  ROUTER_BASE_URL: "http://localhost:20128/v1",
  ROUTER_API_KEY: "test-key-not-a-real-secret",
  CODER_MODEL: "grip/deepseek-v4.1-flash",
  REVIEWER_MODEL: "grip/gpt-5.6-luna",
};

describe("assessConfiguration — fresh install", () => {
  it("reports a first run when nothing is configured", () => {
    const result = assess({});
    expect(result.valid).toBe(false);
    expect(result.firstRun).toBe(true);
    expect(result.configFileExists).toBe(false);
    expect(result.envFileExists).toBe(false);
    expect(result.hasApiKey).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain("MISSING_API_KEY");
  });

  it("isFirstRun / hasValidConfiguration agree with the assessment", () => {
    expect(isFirstRun({ env: {}, cwd: dir, loadDotEnv: false, configPath: configPath() })).toBe(true);
    expect(hasValidConfiguration({ env: {}, cwd: dir, loadDotEnv: false, configPath: configPath() })).toBe(false);
  });
});

describe("assessConfiguration — configured install", () => {
  it("is valid when env supplies everything", () => {
    const result = assess(FULL_ENV);
    expect(result.valid).toBe(true);
    expect(result.firstRun).toBe(false);
    expect(result.hasApiKey).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("is valid from the JSON file plus env secret", () => {
    writeConfigFile(configPath(), VALID_FILE);
    const result = assess({ ROUTER_API_KEY: "k" });
    expect(result.valid).toBe(true);
    expect(result.configFileExists).toBe(true);
  });
});

describe("assessConfiguration — partial configuration", () => {
  it("is a first run when only the key is missing", () => {
    const result = assess({ ...FULL_ENV, ROUTER_API_KEY: "" });
    expect(result.firstRun).toBe(true);
    expect(result.problems.map((p) => p.code)).toContain("MISSING_API_KEY");
  });

  it("is NOT a first run when the router URL is invalid (misconfigured, not missing)", () => {
    const result = assess({ ...FULL_ENV, ROUTER_BASE_URL: "not-a-url" });
    expect(result.valid).toBe(false);
    expect(result.firstRun).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain("INVALID_ROUTER_URL");
  });

  it("flags identical coder/reviewer models", () => {
    const result = assess({ ...FULL_ENV, REVIEWER_MODEL: "grip/deepseek-v4.1-flash" });
    expect(result.problems.map((p) => p.code)).toContain("IDENTICAL_MODELS");
    expect(result.firstRun).toBe(false);
  });
});

describe("assessConfiguration — broken file", () => {
  it("treats an unreadable JSON file as CONFIG_FILE_INVALID, not a first run", () => {
    writeFileSync(configPath(), "{ not json ");
    const result = assess(FULL_ENV);
    expect(result.valid).toBe(false);
    expect(result.firstRun).toBe(false);
    expect(result.problems[0]?.code).toBe("CONFIG_FILE_INVALID");
  });

  it("does not silently ignore a schema-invalid file", () => {
    writeFileSync(configPath(), JSON.stringify({ models: { coder: "no-slash" } }));
    const result = assess(FULL_ENV);
    expect(result.valid).toBe(false);
    expect(result.problems.some((p) => p.code === "CONFIG_FILE_INVALID")).toBe(true);
  });
});

describe("assessConfiguration — env file presence", () => {
  it("detects a .env file on disk", () => {
    writeFileSync(join(dir, ".env"), "ROUTER_API_KEY=k\n");
    const result = assessConfiguration({ env: {}, cwd: dir, configPath: configPath() });
    expect(result.envFileExists).toBe(true);
    // The key is read from .env, so the API key is present.
    expect(result.hasApiKey).toBe(true);
  });

  it("never returns a secret value in the assessment", () => {
    const secret = "sk-live-abcdef1234567890";
    const result = assess({ ...FULL_ENV, ROUTER_API_KEY: secret });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
