/**
 * JSON-backed configuration file (Phase V2.1).
 *
 * This module is the *only* place that knows the shape of the on-disk config.
 * Everything above it (the config service, the API routes, the Settings UI) works
 * against the validated, typed object this file produces.
 *
 * Design rules honoured here:
 *  - The file is validated with a Zod schema BEFORE anything is written. A bad
 *    patch can never replace a good file.
 *  - Writes are atomic: we write a temp file in the target directory, fsync it,
 *    then rename over the target. A crash mid-write leaves the previous config
 *    intact rather than a truncated file that would break the orchestrator.
 *  - A missing file is not an error: it means "no overrides", which is the exact
 *    behaviour of V2.0. Custom values only exist once someone writes them.
 *  - Secrets are NEVER stored here. The API key and the database URL stay in the
 *    environment (decision: .env wins for secrets, JSON wins for models/roles).
 */

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** A model the operator has introduced (or overridden) in the dashboard. */
export const ConfiguredModelSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, "model id must not be empty")
    .max(200, "model id is too long")
    .regex(/^[^\s/]+\/[^\s]+$/, "model id must look like '<provider>/<model>' (e.g. grip/gpt-5.6-luna)"),
  providerId: z.string().trim().min(1).max(64).optional(),
  contextWindow: z.number().int().min(4096).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  supportsToolCalling: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
});

export type ConfiguredModel = z.infer<typeof ConfiguredModelSchema>;

/**
 * An agent profile.
 *
 * `role` is a free-form slug (not the fixed coder/reviewer/planner union) so the
 * owner can register custom roles such as "frontend-coder" or "security-reviewer".
 * Reserved built-in names are still valid values; they simply override the static
 * defaults for that role.
 */
export const ConfiguredRoleSchema = z.object({
  role: z
    .string()
    .trim()
    .min(1, "role name is required")
    .max(64, "role name is too long")
    .regex(/^[a-z0-9][a-z0-9-]*$/, "role must be a lowercase slug (letters, digits, dashes)"),
  defaultModelId: z
    .string()
    .trim()
    .min(1, "defaultModelId is required")
    .max(200)
    .regex(/^[^\s/]+\/[^\s]+$/, "defaultModelId must look like '<provider>/<model>'"),
  systemPromptTemplate: z
    .string()
    .min(1, "systemPromptTemplate must not be empty")
    .max(20_000, "systemPromptTemplate is too long"),
  allowedTools: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
});

export type ConfiguredRole = z.infer<typeof ConfiguredRoleSchema>;

/** Which model the orchestrator's built-in pipeline should use for each stage. */
export const TaskModelsSchema = z.object({
  coder: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\s/]+\/[^\s]+$/, "coder model must look like '<provider>/<model>'")
    .optional(),
  reviewer: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\s/]+\/[^\s]+$/, "reviewer model must look like '<provider>/<model>'")
    .optional(),
  planner: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\s/]+\/[^\s]+$/, "planner model must look like '<provider>/<model>'")
    .optional(),
});

export type TaskModels = z.infer<typeof TaskModelsSchema>;

export const AiTeamConfigFileSchema = z
  .object({
    /** Schema version, so future migrations are explicit rather than guessed. */
    version: z.literal(1).default(1),
    models: TaskModelsSchema.default({}),
    /** Extra models the operator pinned, merged with the built-in catalogue. */
    catalog: z.array(ConfiguredModelSchema).max(200).default([]),
    /** Overrides for built-in roles AND brand-new custom roles. */
    roles: z.array(ConfiguredRoleSchema).max(200).default([]),
    /**
     * Optional operator-visible fields. Arbitrary extra keys are rejected below so
     * a typo in the UI cannot silently become a dead setting.
     */
    notes: z.string().max(2_000).optional(),
  })
  .strict();

export type AiTeamConfigFile = z.infer<typeof AiTeamConfigFileSchema>;

export const EMPTY_CONFIG: AiTeamConfigFile = Object.freeze({
  version: 1,
  models: {},
  catalog: [],
  roles: [],
}) as AiTeamConfigFile;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ConfigIssue {
  /** Dotted path, e.g. "roles.0.role" or "models.coder". */
  path: string;
  message: string;
}

/**
 * Raised when the on-disk file (or a proposed patch) is not valid.
 *
 * Distinct from `ConfigError` in env.ts: that one describes environment problems,
 * this one describes the JSON document and carries field-level detail the UI can
 * render next to the offending input.
 */
export class ConfigFileError extends Error {
  readonly issues: ConfigIssue[];
  readonly filePath: string;

  constructor(message: string, options: { issues?: ConfigIssue[]; filePath?: string } = {}) {
    super(message);
    this.name = "ConfigFileError";
    this.issues = options.issues ?? [];
    this.filePath = options.filePath ?? "";
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export const CONFIG_PATH_ENV = "AI_TEAM_CONFIG_PATH";
export const DEFAULT_CONFIG_FILENAME = "ai-team.config.json";

/**
 * Resolves the config file path.
 *
 * Precedence: explicit argument > AI_TEAM_CONFIG_PATH > `<cwd>/ai-team.config.json`.
 * A relative value is resolved against `cwd` (never against the process CWD
 * implicitly, so callers stay testable).
 */
export function resolveConfigPath(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  const fromEnv = env[CONFIG_PATH_ENV]?.trim();
  if (fromEnv) return isAbsolute(fromEnv) ? resolve(fromEnv) : resolve(cwd, fromEnv);
  return resolve(cwd, DEFAULT_CONFIG_FILENAME);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function toIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

/**
 * Parses an already-decoded object. Exported so the service can validate a
 * proposed patch without touching disk.
 */
export function parseConfigFile(value: unknown, filePath = ""): AiTeamConfigFile {
  const result = AiTeamConfigFileSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigFileError("The configuration is not valid.", {
      issues: toIssues(result.error),
      filePath,
    });
  }
  return result.data;
}

/** Non-throwing validation, for the /validate endpoint and live UI feedback. */
export function validateConfigFile(
  value: unknown,
  filePath = "",
): { ok: true; data: AiTeamConfigFile } | { ok: false; issues: ConfigIssue[] } {
  const result = AiTeamConfigFileSchema.safeParse(value);
  if (!result.success) return { ok: false, issues: toIssues(result.error) };
  return { ok: true, data: result.data };
}

/**
 * Reads and validates the file.
 *
 * Returns `EMPTY_CONFIG` when the file is absent — "no overrides" is a valid
 * configuration, not a failure. Raises `ConfigFileError` when the file exists but
 * is unreadable JSON or fails validation: silently ignoring a broken file would
 * mean the dashboard shows defaults while the operator believes their edits are
 * live, which is exactly the confusion this feature must avoid.
 */
export function readConfigFile(filePath: string): AiTeamConfigFile {
  if (!existsSync(filePath)) return EMPTY_CONFIG;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new ConfigFileError(
      `Could not read the configuration file: ${error instanceof Error ? error.message : String(error)}`,
      { filePath },
    );
  }

  // An empty (or whitespace-only) file is treated as "no overrides", so a file
  // created with `touch` does not break startup.
  if (raw.trim() === "") return EMPTY_CONFIG;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigFileError(
      `The configuration file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { filePath },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigFileError("The configuration file must contain a JSON object.", { filePath });
  }

  return parseConfigFile(parsed, filePath);
}

// ---------------------------------------------------------------------------
// Write (atomic)
// ---------------------------------------------------------------------------

/** Stable hash of the file contents, used by the UI to detect drift. */
export function hashConfig(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

/** Serialises with a trailing newline and two-space indent — diff-friendly. */
export function serializeConfigFile(config: AiTeamConfigFile): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export interface ConfigFileMeta {
  path: string;
  exists: boolean;
  mtimeMs?: number;
  sizeBytes?: number;
  hash?: string;
}

export function statConfigFile(filePath: string): ConfigFileMeta {
  if (!existsSync(filePath)) return { path: filePath, exists: false };
  const stat = statSync(filePath);
  let hash: string | undefined;
  try {
    hash = hashConfig(readFileSync(filePath, "utf8"));
  } catch {
    hash = undefined;
  }
  return {
    path: filePath,
    exists: true,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    ...(hash ? { hash } : {}),
  };
}

/**
 * Writes the configuration atomically.
 *
 * The sequence is: write temp file → flush to disk → rename over the target. On
 * the same filesystem a rename is atomic, so a reader either sees the old file or
 * the new one, never a half-written one. If anything throws, the temp file is
 * removed and the original is untouched.
 *
 * A `.bak` copy of the previous contents is kept so an operator can roll back by
 * hand; we deliberately do not add a rollback API in V2.1.
 */
export function writeConfigFile(
  filePath: string,
  config: AiTeamConfigFile,
  options: { keepBackup?: boolean } = {},
): ConfigFileMeta {
  const validated = parseConfigFile(config, filePath);
  const serialized = serializeConfigFile(validated);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    throw new ConfigFileError(`The configuration directory does not exist: ${dir}`, { filePath });
  }

  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
    writeSync(fd, serialized, null, "utf8");
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
      fd = undefined;
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // best effort
    }
    throw new ConfigFileError(
      `Could not write the configuration file: ${error instanceof Error ? error.message : String(error)}`,
      { filePath },
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
  }

  if (options.keepBackup !== false && existsSync(filePath)) {
    try {
      const previous = readFileSync(filePath, "utf8");
      const backupPath = `${filePath}.bak`;
      const backupFd = openSync(backupPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
      try {
        writeSync(backupFd, previous, null, "utf8");
      } finally {
        closeSync(backupFd);
      }
    } catch {
      // A failed backup must not fail the write; the temp file already holds the
      // only copy we care about, and the rename below is the real commit.
    }
  }

  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best effort
    }
    throw new ConfigFileError(
      `Could not replace the configuration file: ${error instanceof Error ? error.message : String(error)}`,
      { filePath },
    );
  }

  return statConfigFile(filePath);
}
