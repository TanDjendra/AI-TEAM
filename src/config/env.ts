/**
 * Environment configuration for 9Router.
 *
 * Rules honoured here:
 *  - No API key is ever hard-coded. Values come from the environment.
 *  - The `.env` file is read by hand (no dotenv dependency) *without* clobbering
 *    variables that are already set, so CI/OS env always wins.
 *  - Secrets are redacted by `describe()` so they can be logged safely.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isLogLevel, type LogFormat, type LogLevel } from "../domain/logger.js";
import type { AgentProfile, ModelProfile } from "../domain/types.js";
import { getAgentProfile, resolveAgentProfiles } from "./agent-profiles.js";
import { getModelProfile, resolveModelProfiles, synthesizeModelProfile } from "./model-profiles.js";
import {
  ConfigFileError,
  readConfigFile,
  resolveConfigPath,
  type AiTeamConfigFile,
} from "./config-file.js";

export interface CoderConfig {
  model: string;
  agentProfile: AgentProfile;
  modelProfile: ModelProfile;
}

export interface PlannerConfig {
  model: string;
}

export interface ReviewerConfig {
  model: string;
  agentProfile: AgentProfile;
  modelProfile: ModelProfile;
}

export interface RouterConfig {
  baseUrl: string;
  apiKey: string;
  /** Where the key came from — useful for diagnostics, never contains the key. */
  apiKeySource: "env" | "none";
  timeoutMs: number;
  maxRetries: number;
  verifyOnStart: boolean;
}

export interface OrchestratorConfig {
  maxReviewCycles: number;
  maxAgentAttempts: number;
  workspaceRoot: string;
  /**
   * How long a run may go without a heartbeat before it is considered abandoned
   * (PHASE 6). Also the threshold the dashboard shows as "stale".
   */
  staleRunThresholdMs: number;
  /** How often a running task refreshes its heartbeat. */
  heartbeatIntervalMs: number;
  /** How often the automatic sweeper runs to detect and recover stale tasks. */
  staleSweepIntervalMs: number;
  /** Phase 7C: Maximum total tokens (input+output) allowed per task */
  maxTaskTokens?: number;
  /** Phase 7C: Maximum total tokens allowed for the coder agent */
  maxCoderTokens?: number;
  /** Phase 7C: Maximum total tokens allowed for the reviewer agent */
  maxReviewerTokens?: number;
  /** Phase 7C: Maximum total tool turns (iterations) allowed per task */
  maxToolTurns?: number;
  /** Phase 7C: Maximum cost in standard units (or USD) per task */
  maxTaskCost?: number;
  /** Phase V2-04: Enable Workflow/DAG subsystem (default false). */
  workflowEnabled: boolean;
  /** Phase V2-07: Enable Git workspace isolation (default false). */
  gitWorkspaceEnabled: boolean;
  /** Phase V2-08: Maximum concurrent workflow nodes dispatched by the WorkerPool (default 4). */
  workerPoolSize: number;
  /** Phase 7C: Enable adaptive context compaction (default false) */
  contextCompactionEnabled: boolean;
  /** Phase 7C: The ratio of context window at which compaction triggers (default 0.75) */
  contextCompactionRatio: number;
  /** Phase 7C: The maximum tokens the model supports natively */
  modelContextWindow: number;
}

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
}

export interface AppConfig {
  router: RouterConfig;
  coder: CoderConfig;
  reviewer: ReviewerConfig;
  planner: PlannerConfig;
  orchestrator: OrchestratorConfig;
  logging: LoggingConfig;
  database: DatabaseConfig;
  /**
   * Absolute path of the JSON config file this configuration was resolved with
   * (Phase V2.1). The dashboard shows it so the operator knows what a save edits.
   */
  configFilePath: string;
  /**
   * The validated JSON document, kept so the config service can diff a proposed
   * change against what is actually loaded.
   */
  configFile: AiTeamConfigFile;
}

export interface DatabaseConfig {
  /**
   * PostgreSQL connection string (Supabase Postgres works as-is).
   * When absent, the orchestrator runs without persistence: the event bus and
   * transports still work, nothing is written to a database.
   */
  url?: string;
  /**
   * Directory for an embedded PostgreSQL (PGlite) instead of a server.
   *
   * This is real Postgres compiled to WASM, persisted to disk — useful for local
   * development and demos where no Postgres server is available. It is
   * single-process: the orchestrator CLI and the dashboard cannot open it at the
   * same time. Prefer `url` for anything shared.
   */
  pgliteDir?: string;
  /** Extra TLS flag, e.g. for a server with a self-signed certificate. */
  ssl: boolean;
  /** Pool size. */
  maxConnections: number;
  /** Directory holding `*.sql` migrations. */
  migrationsDir: string;
  /**
   * Refuse to mark a task DONE when persistence is unhealthy. Defaults to true
   * when a database is configured — a task must not look complete when the
   * record of it was lost.
   */
  requirePersistence: boolean;
}

export class ConfigError extends Error {
  readonly fields: string[];

  constructor(message: string, fields: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.fields = fields;
  }
}

export interface LoadConfigOptions {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Project root used to locate `.env` and the default workspace. Defaults to cwd. */
  cwd?: string;
  /** Load `<cwd>/.env` (default true). Real environment always takes precedence. */
  loadDotEnv?: boolean;
  /**
   * Explicit JSON config file path (Phase V2.1). Defaults to resolving
   * `AI_TEAM_CONFIG_PATH` then `<cwd>/ai-team.config.json`.
   */
  configPath?: string;
}

const DEFAULT_BASE_URL = "http://localhost:20128/v1";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
export const MAX_REVIEW_CYCLES_DEFAULT = 3;

/** Minimal .env parser: KEY=VALUE, `#` comments, optional surrounding quotes. */
export function parseDotEnv(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // Strip trailing inline comments for unquoted values.
    if (!rawLine.trim().includes('"') && !rawLine.trim().includes("'")) {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Reads the API key from the environment.
 *
 * There is deliberately NO fallback to a local secret file. An earlier version
 * tried to reuse 9Router's on-disk CLI secret; it was verified to be rejected
 * with 401 by /v1/chat/completions, so the fallback both failed and encouraged
 * treating an unrelated application secret as a router credential. The key must
 * be supplied explicitly.
 */
export function readRouterCliSecret(): undefined {
  return undefined;
}

function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/** True for a base URL pointing at this machine. Exported for diagnostics. */
export function isLocalRouterUrl(baseUrl: string): boolean {
  return isLoopback(baseUrl);
}

function positiveInt(
  raw: string | undefined,
  fallback: number,
  field: string,
  errors: string[],
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    errors.push(`${field} must be an integer between ${min} and ${max} (received "${raw}")`);
    return fallback;
  }
  return parsed;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();
  const processEnv = options.env ?? process.env;

  const env: Record<string, string | undefined> = { ...processEnv };

  if (options.loadDotEnv !== false) {
    try {
      const fileEnv = parseDotEnv(readFileSync(join(cwd, ".env"), "utf8"));
      for (const [key, value] of Object.entries(fileEnv)) {
        // Real environment wins over the file.
        if (env[key] === undefined || env[key] === "") env[key] = value;
      }
    } catch {
      // No .env is a valid setup: everything can come from the real environment.
    }
  }

  const errors: string[] = [];

  // --- V2.1: JSON config file ------------------------------------------------
  // Read once. A broken file is a hard error: silently falling back to defaults
  // would show the operator a working dashboard while their saved edits are not
  // actually in force, which is the exact confusion V2.1 exists to remove.
  const configFilePath = options.configPath ?? resolveConfigPath(processEnv, cwd);
  let configFile: AiTeamConfigFile;
  try {
    configFile = readConfigFile(configFilePath);
  } catch (error) {
    if (error instanceof ConfigFileError) {
      throw error;
    }
    throw new ConfigFileError(
      `Could not load the configuration file: ${error instanceof Error ? error.message : String(error)}`,
      { filePath: configFilePath },
    );
  }

  // Effective profiles: built-in defaults overlaid with the JSON document.
  const agentProfiles = resolveAgentProfiles(configFile.roles);
  const modelProfiles = resolveModelProfiles(configFile.catalog);

  const baseUrl = (env.ROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push("ROUTER_BASE_URL must be an http(s) URL");
    }
  } catch {
    errors.push(`ROUTER_BASE_URL is not a valid URL (received "${baseUrl}")`);
  }
  const explicitCoderModel = env.CODER_MODEL?.trim();
  const explicitReviewerModel = env.REVIEWER_MODEL?.trim();
  const explicitPlannerModel = env.PLANNER_MODEL?.trim();

  // Precedence (V2.1 decision): the JSON file WINS for models and roles, so a
  // change saved in the dashboard actually takes effect. The environment is the
  // fallback and remains authoritative for secrets (see `router` below).
  const coderModel = configFile.models.coder ?? explicitCoderModel;
  const reviewerModel = configFile.models.reviewer ?? explicitReviewerModel;
  const plannerModel = configFile.models.planner ?? explicitPlannerModel ?? coderModel;

  if (!coderModel) errors.push("CODER_MODEL is required (e.g. grip/deepseek-v4.1-flash)");
  if (!reviewerModel) errors.push("REVIEWER_MODEL is required (e.g. grip/gpt-5.6-luna)");
  if (coderModel && reviewerModel && coderModel === reviewerModel) {
    errors.push("CODER_MODEL and REVIEWER_MODEL must differ (independent verification)");
  }

  const explicitKey = env.ROUTER_API_KEY?.trim();
  const apiKey = explicitKey ?? "";
  const apiKeySource: RouterConfig["apiKeySource"] = explicitKey ? "env" : "none";

  if (!apiKey) {
    errors.push(
      "ROUTER_API_KEY is required — set it in .env or the environment. " +
        "(/v1/models does not enforce auth on 9Router, so a missing key only " +
        "surfaces when a chat completion is attempted.)",
    );
  }

  const logLevel = (env.LOG_LEVEL?.trim() || "info").toLowerCase();
  if (!isLogLevel(logLevel)) {
    errors.push(`LOG_LEVEL must be one of debug|info|warn|error (received "${logLevel}")`);
  }
  const logFormat = (env.LOG_FORMAT?.trim() || "text").toLowerCase();
  if (logFormat !== "json" && logFormat !== "text") {
    errors.push(`LOG_FORMAT must be "text" or "json" (received "${logFormat}")`);
  }

  const workspaceRoot = env.ORCH_WORKSPACE_ROOT?.trim() || join(cwd, "workspace");

  // Numeric/log options are validated BEFORE the error gate below: parsing them
  // inside the return statement would silently discard their diagnostics.
  const timeoutMs = positiveInt(env.ROUTER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "ROUTER_TIMEOUT_MS", errors, {
    min: 1_000,
    max: 900_000,
  });
  const maxRetries = positiveInt(env.ROUTER_MAX_RETRIES, DEFAULT_MAX_RETRIES, "ROUTER_MAX_RETRIES", errors, {
    min: 0,
    max: 10,
  });
  const maxReviewCycles = positiveInt(
    env.MAX_REVIEW_CYCLES,
    MAX_REVIEW_CYCLES_DEFAULT,
    "MAX_REVIEW_CYCLES",
    errors,
    { min: 1, max: 20 },
  );
  const maxAgentAttempts = positiveInt(env.MAX_AGENT_ATTEMPTS, 2, "MAX_AGENT_ATTEMPTS", errors, {
    min: 1,
    max: 10,
  });
  const maxTaskTokens = positiveInt(env.MAX_TASK_TOKENS, undefined as any, "MAX_TASK_TOKENS", errors);
  const maxCoderTokens = positiveInt(env.MAX_CODER_TOKENS, undefined as any, "MAX_CODER_TOKENS", errors);
  const maxReviewerTokens = positiveInt(env.MAX_REVIEWER_TOKENS, undefined as any, "MAX_REVIEWER_TOKENS", errors);
  const maxToolTurns = positiveInt(env.MAX_TOOL_TURNS, undefined as any, "MAX_TOOL_TURNS", errors);
  const maxTaskCost = positiveInt(env.MAX_TASK_COST, undefined as any, "MAX_TASK_COST", errors);
  const contextCompactionEnabled = bool(env.CONTEXT_COMPACTION_ENABLED, false);
  const contextCompactionRatio = Number(env.CONTEXT_COMPACTION_RATIO?.trim() || "0.75");
  if (Number.isNaN(contextCompactionRatio) || contextCompactionRatio < 0.1 || contextCompactionRatio > 0.95) {
    errors.push("CONTEXT_COMPACTION_RATIO must be a number between 0.1 and 0.95");
  }
  const baseContextWindow = positiveInt(env.MODEL_CONTEXT_WINDOW, 128_000, "MODEL_CONTEXT_WINDOW", errors, { min: 4096 });
  const modelContextWindow = baseContextWindow; // Keep this for OrchestratorConfig compatibility

  const workerPoolSize = positiveInt(env.WORKER_POOL_SIZE, 4, "WORKER_POOL_SIZE", errors, {
    min: 1,
    max: 16,
  });

  const verifyOnStart = bool(env.ROUTER_VERIFY_ON_START, false);

  if (errors.length > 0) {
    throw new ConfigError(
      `Invalid AI Team Orchestrator configuration:\n  - ${errors.join("\n  - ")}`,
      errors,
    );
  }

  return {
    router: {
      baseUrl,
      apiKey,
      apiKeySource,
      timeoutMs,
      maxRetries,
      verifyOnStart,
    },
    coder: {
      model: coderModel as string,
      agentProfile: getAgentProfile("coder", agentProfiles),
      modelProfile:
        getModelProfile(coderModel as string, modelProfiles) ??
        synthesizeModelProfile(coderModel as string, baseContextWindow),
    },
    reviewer: {
      model: reviewerModel as string,
      agentProfile: getAgentProfile("reviewer", agentProfiles),
      modelProfile:
        getModelProfile(reviewerModel as string, modelProfiles) ??
        synthesizeModelProfile(reviewerModel as string, baseContextWindow),
    },
    planner: {
      model: plannerModel as string,
    },
    orchestrator: {
      maxReviewCycles,
      maxAgentAttempts,
      workspaceRoot,
      // Defaults suit an interactive dashboard: a run that has not pinged for two
      // minutes is abandoned, and a live run pings every five seconds.
      staleRunThresholdMs: positiveInt(
        env.ORCH_STALE_THRESHOLD_MS,
        120_000,
        "ORCH_STALE_THRESHOLD_MS",
        errors,
        { min: 5_000, max: 3_600_000 },
      ),
      heartbeatIntervalMs: positiveInt(
        env.HEARTBEAT_INTERVAL_MS,
        5_000,
        "HEARTBEAT_INTERVAL_MS",
        errors,
        { min: 1_000, max: 60_000 },
      ),
      staleSweepIntervalMs: positiveInt(
        env.STALE_SWEEP_INTERVAL_MS,
        60_000,
        "STALE_SWEEP_INTERVAL_MS",
        errors,
        { min: 5_000, max: 300_000 },
      ),
      maxTaskTokens,
      maxCoderTokens,
      maxReviewerTokens,
      maxToolTurns,
      maxTaskCost,
      contextCompactionEnabled,
      contextCompactionRatio,
      modelContextWindow,
      workflowEnabled: bool(env.WORKFLOW_ENABLED, false),
      gitWorkspaceEnabled: bool(env.GIT_WORKSPACE_ENABLED, false),
      workerPoolSize,
    },
    logging: {
      level: (isLogLevel(logLevel) ? logLevel : "info") as LogLevel,
      format: (logFormat === "json" ? "json" : "text") as LogFormat,
    },
    database: {
      ...(env.DATABASE_URL?.trim() ? { url: env.DATABASE_URL.trim() } : {}),
      ...(env.PGLITE_DATA_DIR?.trim() ? { pgliteDir: env.PGLITE_DATA_DIR.trim() } : {}),
      ssl: bool(env.DATABASE_SSL, false),
      maxConnections: positiveInt(env.DATABASE_MAX_CONNECTIONS, 10, "DATABASE_MAX_CONNECTIONS", errors, {
        min: 1,
        max: 100,
      }),
      migrationsDir: env.DATABASE_MIGRATIONS_DIR?.trim() || join(cwd, "supabase", "migrations"),
      requirePersistence: bool(env.DATABASE_REQUIRE_PERSISTENCE, true),
    },
    configFilePath,
    configFile,
  };
}

/** Safe, loggable view of the configuration. Never includes the API key. */
export function describeConfig(config: AppConfig): Record<string, string | number | boolean> {
  return {
    "router.baseUrl": config.router.baseUrl,
    "router.apiKey": config.router.apiKey ? "[configured]" : "[missing]",
    "router.apiKeySource": config.router.apiKeySource,
    "router.timeoutMs": config.router.timeoutMs,
    "router.maxRetries": config.router.maxRetries,
    "router.verifyOnStart": config.router.verifyOnStart,
    "coder.model": config.coder.model,
    "reviewer.model": config.reviewer.model,
    "planner.model": config.planner.model,
    "config.path": config.configFilePath,
    "config.customRoles": config.configFile.roles.length,
    "config.catalogEntries": config.configFile.catalog.length,
    "orchestrator.maxReviewCycles": config.orchestrator.maxReviewCycles,
    "orchestrator.maxAgentAttempts": config.orchestrator.maxAgentAttempts,
    "orchestrator.staleRunThresholdMs": config.orchestrator.staleRunThresholdMs,
    "orchestrator.heartbeatIntervalMs": config.orchestrator.heartbeatIntervalMs,
    "orchestrator.workerPoolSize": config.orchestrator.workerPoolSize,
    "orchestrator.staleSweepIntervalMs": config.orchestrator.staleSweepIntervalMs,
    "orchestrator.workspaceRoot": config.orchestrator.workspaceRoot,
    "logging.level": config.logging.level,
    "logging.format": config.logging.format,
    // Never the connection string: it contains the database password.
    "database.configured": config.database.url ? "[configured]" : config.database.pgliteDir ? "[pglite]" : "[disabled]",
    "database.ssl": config.database.ssl,
    "database.maxConnections": config.database.maxConnections,
    "database.requirePersistence": config.database.requirePersistence,
  };
}

// ---------------------------------------------------------------------------
// First-run detection & configuration readiness (Phase 1)
// ---------------------------------------------------------------------------
//
// The product CLI and the setup wizard need one honest answer to "is this
// installation ready to run?" — and it must NOT be "does a file exist". A file
// can exist and still be invalid, incomplete, or point at a router with no key.
//
// `assessConfiguration` runs the SAME `loadConfig` the runtime uses, so what it
// reports is exactly what the orchestrator would do at startup. Nothing is
// inferred from filenames.

/** A configuration problem, already classified for a setup UI. */
export interface ConfigProblem {
  /** Machine-readable code, stable for the wizard to branch on. */
  code:
    | "CONFIG_FILE_INVALID"
    | "MISSING_API_KEY"
    | "MISSING_CODER_MODEL"
    | "MISSING_REVIEWER_MODEL"
    | "IDENTICAL_MODELS"
    | "INVALID_ROUTER_URL"
    | "INVALID_ENV";
  message: string;
}

export interface ConfigurationAssessment {
  /** True when the installation can run without further setup. */
  valid: boolean;
  /**
   * True when this looks like a first run: no usable configuration was found,
   * i.e. the failing reasons are all "missing", none "misconfigured". A broken
   * file is NOT a first run — it is an incomplete/broken setup the operator must
   * fix, and the two need different wizard copy.
   */
  firstRun: boolean;
  /** The resolved config path, whether or not a file exists there. */
  configPath: string;
  /** Whether the JSON config file exists on disk. */
  configFileExists: boolean;
  /** Whether `.env` exists on disk. */
  envFileExists: boolean;
  /** Whether ROUTER_API_KEY is present and non-empty (never the value). */
  hasApiKey: boolean;
  /** Every problem found, empty when `valid` is true. */
  problems: ConfigProblem[];
}

export interface AssessConfigurationOptions extends LoadConfigOptions {}

/**
 * Classifies the raw messages `loadConfig` produces into stable codes.
 *
 * Deliberately a small substring map over the known diagnostics, so the wizard
 * gets a stable vocabulary while `loadConfig` remains the single validator.
 */
function classifyConfigError(errors: readonly string[]): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  for (const message of errors) {
    let code: ConfigProblem["code"] = "INVALID_ENV";
    if (message.includes("ROUTER_API_KEY is required")) code = "MISSING_API_KEY";
    else if (message.includes("ROUTER_BASE_URL")) code = "INVALID_ROUTER_URL";
    else if (message.includes("CODER_MODEL is required")) code = "MISSING_CODER_MODEL";
    else if (message.includes("REVIEWER_MODEL is required")) code = "MISSING_REVIEWER_MODEL";
    else if (message.includes("must differ")) code = "IDENTICAL_MODELS";
    problems.push({ code, message });
  }
  return problems;
}

/**
 * Assesses whether the installation is configured and runnable.
 *
 * Uses `readFileSync` presence checks only for the file-existence flags; the
 * pass/fail verdict comes from actually attempting `loadConfig`.
 *
 * A `ConfigFileError` (a present-but-broken JSON file) is reported as
 * `CONFIG_FILE_INVALID` and makes `firstRun` false: the operator has configured
 * something, it is simply wrong. A missing key/models makes `firstRun` true.
 */
export function assessConfiguration(
  options: AssessConfigurationOptions = {},
): ConfigurationAssessment {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? resolveConfigPath(options.env ?? process.env, cwd);

  const configFileExists = existsSync(configPath);
  const envFileExists = existsSync(join(cwd, ".env"));

  // Read file presence for the honest flags above, but never trust presence as
  // readiness. The real verdict is the same loadConfig the runtime performs.
  let hasApiKey = false;
  try {
    const merged: Record<string, string | undefined> = { ...(options.env ?? process.env) };
    if (options.loadDotEnv !== false) {
      try {
        const fileEnv = parseDotEnv(readFileSync(join(cwd, ".env"), "utf8"));
        for (const [key, value] of Object.entries(fileEnv)) {
          if (merged[key] === undefined || merged[key] === "") merged[key] = value;
        }
      } catch {
        // No .env is a normal state.
      }
    }
    hasApiKey = Boolean(merged.ROUTER_API_KEY?.trim());
  } catch {
    hasApiKey = false;
  }

  try {
    loadConfig(options);
    return {
      valid: true,
      firstRun: false,
      configPath,
      configFileExists,
      envFileExists,
      hasApiKey,
      problems: [],
    };
  } catch (error) {
    if (error instanceof ConfigFileError) {
      return {
        valid: false,
        firstRun: false,
        configPath,
        configFileExists,
        envFileExists,
        hasApiKey,
        problems: [
          {
            code: "CONFIG_FILE_INVALID",
            message: error.message,
          },
        ],
      };
    }
    if (error instanceof ConfigError) {
      const problems = classifyConfigError(error.fields);
      // A first run = nothing usable configured yet. If every failing reason is
      // a *missing* secret/model, there is nothing to repair, only to set up.
      const missingCodes: ReadonlySet<ConfigProblem["code"]> = new Set([
        "MISSING_API_KEY",
        "MISSING_CODER_MODEL",
        "MISSING_REVIEWER_MODEL",
      ]);
      const firstRun = problems.length > 0 && problems.every((p) => missingCodes.has(p.code));
      return {
        valid: false,
        firstRun,
        configPath,
        configFileExists,
        envFileExists,
        hasApiKey,
        problems,
      };
    }

    return {
      valid: false,
      firstRun: false,
      configPath,
      configFileExists,
      envFileExists,
      hasApiKey,
      problems: [
        {
          code: "INVALID_ENV",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

/** Convenience predicate: is this installation ready to run? */
export function hasValidConfiguration(options: AssessConfigurationOptions = {}): boolean {
  return assessConfiguration(options).valid;
}

/**
 * True only for a genuine first run.
 *
 * Note the deliberate asymmetry: a *broken* config file returns `false` here
 * (it is a repair, not a first run). Callers that need "needs the wizard" should
 * consult `assessConfiguration().valid` instead of this alone.
 */
export function isFirstRun(options: AssessConfigurationOptions = {}): boolean {
  return assessConfiguration(options).firstRun;
}
