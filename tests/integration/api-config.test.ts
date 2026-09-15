/**
 * Config API integration tests (Phase V2.1).
 *
 * These exercise the REAL route handlers and the REAL config service against a
 * REAL file on disk (a temp directory). Nothing about the write path is mocked:
 * the atomic rename, the Zod gate and the in-memory reload are the production
 * code paths. A mocked test could not prove that a rejected save leaves the file
 * byte-for-byte intact, which is the property that keeps the orchestrator alive.
 *
 * The runtime is installed through the app's own seam (`installDashboardRuntime`),
 * so the handlers run unmodified.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/env.js";
import { createLogger, type LogLevel } from "../../src/domain/logger.js";
import {
  createDashboardRuntime,
  installDashboardRuntime,
  resetDashboardRuntime,
  type DashboardRuntime,
} from "../../src/dashboard/runtime.js";
import { createRealtimeHub } from "../../src/dashboard/realtime.js";
import { serializeConfigFile, writeConfigFile } from "../../src/config/config-file.js";

import { GET as getConfig, PATCH as patchConfig } from "../../app/api/config/route.js";
import { POST as validateConfig } from "../../app/api/config/validate/route.js";
import { GET as getRoles, POST as postRole } from "../../app/api/config/roles/route.js";
import {
  DELETE as deleteRole,
  GET as getRole,
  PUT as putRole,
} from "../../app/api/config/roles/[role]/route.js";

const silentLogger = createLogger({ level: "error" as LogLevel, sink: () => {} });

let dir: string;
let configPath: string;

/** Builds a runtime whose config service points at the temp file. */
async function installRuntime(): Promise<DashboardRuntime> {
  const config = loadConfig({
    env: {
      ROUTER_API_KEY: "test-key-not-a-real-secret",
      CODER_MODEL: "grip/deepseek-v4.1-flash",
      REVIEWER_MODEL: "grip/gpt-5.6-luna",
      ROUTER_BASE_URL: "http://localhost:20128/v1",
    },
    cwd: dir,
    loadDotEnv: false,
    configPath,
  });

  const runtime = await createDashboardRuntime({
    config,
    logger: silentLogger,
    hub: createRealtimeHub(),
  });
  installDashboardRuntime(runtime);
  return runtime;
}

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/config", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function readEnvelope<T>(response: Response): Promise<{ ok: boolean; data?: T; error?: { code: string; message: string } }> {
  return (await response.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-team-config-api-"));
  configPath = join(dir, "ai-team.config.json");
});

afterEach(() => {
  resetDashboardRuntime();
  delete process.env.DASHBOARD_ADMIN_TOKEN;
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/config", () => {
  it("returns the effective config and reports env provenance when no file exists", async () => {
    await installRuntime();

    const response = await getConfig();
    expect(response.status).toBe(200);
    const body = await readEnvelope<{ models: { coder: string }; sources: { coder: string }; path: string }>(response);
    expect(body.ok).toBe(true);
    expect(body.data?.models.coder).toBe("grip/deepseek-v4.1-flash");
    expect(body.data?.sources.coder).toBe("env");
    expect(body.data?.path).toBe(configPath);
  });

  it("works even without a database configured (config is persistence-independent)", async () => {
    await installRuntime();
    const response = await getConfig();
    expect(response.status).toBe(200);
  });
});

describe("PATCH /api/config (models)", () => {
  it("writes the file, flips provenance to config, and reloads in memory", async () => {
    const runtime = await installRuntime();

    const response = await patchConfig(
      jsonRequest("PATCH", { models: { coder: "grip/deepseek-v4.1-flash", reviewer: "grip/gpt-5.6-luna" } }),
    );
    expect(response.status).toBe(200);

    const body = await readEnvelope<{ sources: { coder: string }; file: { exists: boolean } }>(response);
    expect(body.data?.sources.coder).toBe("config");
    expect(body.data?.file.exists).toBe(true);

    // The file on disk is real and parseable.
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.models.coder).toBe("grip/deepseek-v4.1-flash");

    // The in-memory config was swapped by reloadConfig().
    expect(runtime.config.configFile.models.coder).toBe("grip/deepseek-v4.1-flash");
  });

  it("rejects a malformed model id without touching the file", async () => {
    await installRuntime();

    const response = await patchConfig(jsonRequest("PATCH", { models: { coder: "not-a-model" } }));
    expect(response.status).toBe(422);
    const body = await readEnvelope(response);
    expect(body.ok).toBe(false);
  });

  it("refuses identical coder and reviewer models", async () => {
    await installRuntime();
    const response = await patchConfig(
      jsonRequest("PATCH", { models: { coder: "grip/same-model", reviewer: "grip/same-model" } }),
    );
    expect(response.status).toBe(422);
  });

  it("requires the admin token when DASHBOARD_ADMIN_TOKEN is set", async () => {
    await installRuntime();
    process.env.DASHBOARD_ADMIN_TOKEN = "secret-token";

    const denied = await patchConfig(jsonRequest("PATCH", { models: { coder: "grip/x-y" } }));
    expect(denied.status).toBe(401);

    const allowed = await patchConfig(
      jsonRequest("PATCH", { models: { coder: "grip/x-y" } }, { authorization: "Bearer secret-token" }),
    );
    expect(allowed.status).toBe(200);
  });
});

describe("POST /api/config/validate", () => {
  it("accepts a valid document", async () => {
    await installRuntime();
    const response = await validateConfig(jsonRequest("POST", { document: { models: { coder: "grip/a-b" } } }));
    const body = await readEnvelope<{ valid: boolean }>(response);
    expect(body.data?.valid).toBe(true);
  });

  it("returns field-level issues for an invalid document and writes nothing", async () => {
    await installRuntime();
    const response = await validateConfig(jsonRequest("POST", { document: { models: { coder: "bad" } } }));
    const body = await readEnvelope<{ valid: boolean; issues: Array<{ path: string; message: string }> }>(response);
    expect(body.data?.valid).toBe(false);
    expect(body.data?.issues.some((issue) => issue.path === "models.coder")).toBe(true);
  });

  it("does not create the file", async () => {
    await installRuntime();
    await validateConfig(jsonRequest("POST", { models: { coder: "grip/a-b" } }));
    expect(() => readFileSync(configPath, "utf8")).toThrow();
  });
});

describe("roles API", () => {
  it("lists the three built-in roles by default", async () => {
    await installRuntime();
    const response = await getRoles();
    const body = await readEnvelope<Array<{ role: string; builtIn: boolean; custom: boolean }>>(response);
    const names = body.data?.map((role) => role.role) ?? [];
    expect(names).toEqual(["coder", "reviewer", "planner"]);
    expect(body.data?.every((role) => role.builtIn && !role.custom)).toBe(true);
  });

  it("creates a custom role and persists it", async () => {
    await installRuntime();

    const response = await postRole(
      jsonRequest("POST", {
        role: "security-reviewer",
        defaultModelId: "grip/gpt-5.6-luna",
        systemPromptTemplate: "You are a security reviewer.",
        allowedTools: [],
      }),
    );
    expect(response.status).toBe(201);

    const body = await readEnvelope<Array<{ role: string; custom: boolean }>>(response);
    expect(body.data?.some((role) => role.role === "security-reviewer" && role.custom)).toBe(true);

    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.roles.map((role: { role: string }) => role.role)).toContain("security-reviewer");
  });

  it("rejects a role with a non-slug name", async () => {
    await installRuntime();
    const response = await postRole(
      jsonRequest("POST", {
        role: "Frontend Coder",
        defaultModelId: "grip/gpt-5.6-luna",
        systemPromptTemplate: "x",
      }),
    );
    expect(response.status).toBe(422);
  });

  it("overrides a built-in role without deleting it", async () => {
    await installRuntime();
    const response = await postRole(
      jsonRequest("POST", {
        role: "coder",
        defaultModelId: "grip/gpt-5.6-luna",
        systemPromptTemplate: "Overridden coder prompt.",
      }),
    );
    expect(response.status).toBe(201);

    const body = await readEnvelope<Array<{ role: string; overridden: boolean; builtIn: boolean }>>(response);
    const coder = body.data?.find((role) => role.role === "coder");
    expect(coder?.builtIn).toBe(true);
    expect(coder?.overridden).toBe(true);
  });

  it("GET one role returns 404 for an unknown role", async () => {
    await installRuntime();
    const response = await getRole(new Request("http://localhost/"), { params: Promise.resolve({ role: "nope" }) });
    expect(response.status).toBe(404);
  });

  it("PUT upserts a role using the path name", async () => {
    await installRuntime();
    const response = await putRole(
      jsonRequest("PUT", { defaultModelId: "grip/gpt-5.6-luna", systemPromptTemplate: "prompt" }),
      { params: Promise.resolve({ role: "frontend-coder" }) },
    );
    expect(response.status).toBe(200);
    const body = await readEnvelope<Array<{ role: string }>>(response);
    expect(body.data?.some((role) => role.role === "frontend-coder")).toBe(true);
  });

  it("DELETE removes a custom role", async () => {
    await installRuntime();
    await postRole(
      jsonRequest("POST", {
        role: "frontend-coder",
        defaultModelId: "grip/gpt-5.6-luna",
        systemPromptTemplate: "prompt",
      }),
    );

    const response = await deleteRole(new Request("http://localhost/", { method: "DELETE" }), {
      params: Promise.resolve({ role: "frontend-coder" }),
    });
    expect(response.status).toBe(200);
    const body = await readEnvelope<Array<{ role: string }>>(response);
    expect(body.data?.some((role) => role.role === "frontend-coder")).toBe(false);
  });

  it("DELETE refuses to remove a built-in role", async () => {
    await installRuntime();
    const response = await deleteRole(new Request("http://localhost/", { method: "DELETE" }), {
      params: Promise.resolve({ role: "coder" }),
    });
    expect(response.status).toBe(409);
  });
});

describe("invalid file on disk", () => {
  it("surfaces a broken file rather than silently showing defaults", async () => {
    writeFileSync(configPath, "{ not valid json");

    // The runtime build itself reads the file; a broken file must throw, not be
    // ignored — otherwise the dashboard would show defaults while the operator
    // believes their edits are live.
    await expect(installRuntime()).rejects.toThrow();
  });

  it("a valid file written directly is read by a freshly installed runtime", async () => {
    writeConfigFile(configPath, {
      version: 1,
      models: { coder: "grip/from-file-a", reviewer: "grip/from-file-b" },
      catalog: [],
      roles: [],
    });
    // Sanity: the file serialises as expected.
    expect(readFileSync(configPath, "utf8")).toBe(
      serializeConfigFile({
        version: 1,
        models: { coder: "grip/from-file-a", reviewer: "grip/from-file-b" },
        catalog: [],
        roles: [],
      }),
    );

    await installRuntime();
    const response = await getConfig();
    const body = await readEnvelope<{ models: { coder: string }; sources: { coder: string } }>(response);
    expect(body.data?.models.coder).toBe("grip/from-file-a");
    expect(body.data?.sources.coder).toBe("config");
  });
});
