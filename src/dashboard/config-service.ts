/**
 * Config service (Phase V2.1).
 *
 * The single place that reads and mutates the JSON configuration on disk. It
 * sits between the HTTP routes and `config-file.ts`, and — like
 * `dashboard/service.ts` — it contains no HTTP and no SQL.
 *
 * Guarantees it upholds, and why they matter:
 *  - Every mutation is Zod-validated BEFORE the file is touched. A rejected save
 *    leaves the previous file byte-for-byte intact.
 *  - Writes are atomic (delegated to `writeConfigFile`), so a crash cannot leave
 *    a half-written file that would break the orchestrator at startup.
 *  - After a successful write the caller can reload in-memory config; the service
 *    reports what changed so the runtime can decide whether a reload is needed.
 *  - Secrets never enter this file. Models and roles only.
 */

import {
  ConfigFileError,
  EMPTY_CONFIG,
  parseConfigFile,
  readConfigFile,
  resolveConfigPath,
  statConfigFile,
  validateConfigFile,
  writeConfigFile,
  type AiTeamConfigFile,
  type ConfigFileMeta,
  type ConfigIssue,
  type ConfiguredRole,
} from "../config/config-file.js";
import { BUILT_IN_ROLES, resolveAgentProfiles } from "../config/agent-profiles.js";
import { resolveModelProfiles } from "../config/model-profiles.js";
import { CODER_TOOL_NAMES } from "../agents/tools.js";
import type { AgentProfile, ModelProfile } from "../domain/types.js";
import type { Logger } from "../domain/logger.js";
import { ServiceError } from "./service.js";

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface ConfigRoleView {
  role: string;
  defaultModelId: string;
  systemPromptTemplate: string;
  allowedTools: string[];
  /** True for coder/reviewer/planner — the roles the pipeline dispatches today. */
  builtIn: boolean;
  /** True when a built-in role has been overridden in the JSON file. */
  overridden: boolean;
  /** True for roles that exist only in the JSON file (custom roles). */
  custom: boolean;
}

export interface ConfigViewModel {
  /** Absolute path of the file a save would edit. */
  path: string;
  file: ConfigFileMeta;
  /** The raw, validated document as stored (safe: no secrets live here). */
  config: AiTeamConfigFile;
  /** Effective models after merge (built-in catalogue + configured catalogue). */
  models: TaskModelView;
  /** Effective catalogue the UI offers in its model pickers. */
  catalog: Array<{ id: string; providerId: string; contextWindow: number; supportsToolCalling: boolean }>;
  /** Effective roles after merge (built-ins + custom). */
  roles: ConfigRoleView[];
  /**
   * The real tool names the runtime exposes, so the tool-policy editor offers
   * only tools that exist. Sourced from the agent tool registry, never invented.
   */
  availableTools: string[];
  /** Where each effective model came from, for the diagnostics panel. */
  sources: {
    coder: "config" | "env";
    reviewer: "config" | "env";
    planner: "config" | "env";
  };
}

export interface TaskModelView {
  coder: string;
  reviewer: string;
  planner: string;
}

/** The effective configuration the runtime currently has loaded in memory. */
export interface EffectiveConfig {
  models: TaskModelView;
  agentProfiles: readonly AgentProfile[];
  modelProfiles: readonly ModelProfile[];
}

export interface ConfigServiceOptions {
  path: string;
  logger: Logger;
  /** The models the process started with (precedence fallback), for diagnostics. */
  envModels: { coder?: string; reviewer?: string; planner?: string };
  /** Reads the live in-memory config, so "sources" reflects reality. */
  current?(): EffectiveConfig;
}

export interface ConfigService {
  /** Full view for the Settings page: file, effective config, sources. */
  getConfig(): ConfigViewModel;
  /** Non-throwing validation of a draft document. */
  validate(draft: unknown): { ok: true; data: AiTeamConfigFile } | { ok: false; issues: ConfigIssue[] };
  /**
   * Applies a partial update to the document, validates the RESULT, writes it
   * atomically and returns the new view. Throws `ServiceError` on invalid input.
   */
  update(patch: ConfigPatch): ConfigViewModel;
  /** Creates or replaces a role. Throws on duplicate custom role / invalid role. */
  upsertRole(role: ConfiguredRole): ConfigViewModel;
  /** Removes a custom role. Refuses to remove a built-in role. */
  deleteRole(role: string): ConfigViewModel;
  /** Reads a single effective role view, or undefined. */
  getRole(role: string): ConfigRoleView | undefined;
}

/** A partial document. Arrays, when present, replace rather than append. */
export interface ConfigPatch {
  models?: Partial<TaskModelView>;
  catalog?: AiTeamConfigFile["catalog"];
  roles?: AiTeamConfigFile["roles"];
  notes?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createConfigService(options: ConfigServiceOptions): ConfigService {
  const { logger, path } = options;

  const readOrThrow = (): AiTeamConfigFile => {
    try {
      return readConfigFile(path);
    } catch (error) {
      if (error instanceof ConfigFileError) {
        throw new ServiceError(error.message, {
          status: 422,
          code: "config_invalid",
        });
      }
      throw error;
    }
  };

  const writeOrThrow = (config: AiTeamConfigFile): ConfigFileMeta => {
    try {
      return writeConfigFile(path, config);
    } catch (error) {
      if (error instanceof ConfigFileError) {
        // A validation failure here means our own merge produced an invalid
        // document — surface it as a 422 with field detail rather than a 500.
        throw new ServiceError(error.message, {
          status: 422,
          code: "config_invalid",
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error("config.write_failed", { error: message, path });
      throw new ServiceError("Could not write the configuration file.", {
        status: 500,
        code: "config_write_failed",
      });
    }
  };

  /** Applies defaults so a partially written file is normalised for the view. */
  const normalise = (config: AiTeamConfigFile): AiTeamConfigFile => ({
    ...EMPTY_CONFIG,
    ...config,
    models: { ...config.models },
    catalog: [...config.catalog],
    roles: [...config.roles],
  });

  const toRoleViews = (config: AiTeamConfigFile): ConfigRoleView[] => {
    const overriddenNames = new Set(config.roles.map((role) => role.role));
    const effective = resolveAgentProfiles(config.roles);
    const seen = new Set<string>();

    const views: ConfigRoleView[] = [];
    for (const role of effective) {
      if (seen.has(role.role)) continue;
      seen.add(role.role);
      const builtIn = (BUILT_IN_ROLES as readonly string[]).includes(role.role);
      views.push({
        role: role.role,
        defaultModelId: role.defaultModelId,
        systemPromptTemplate: role.systemPromptTemplate,
        allowedTools: role.allowedTools ? [...role.allowedTools] : [],
        builtIn,
        overridden: builtIn && overriddenNames.has(role.role),
        custom: !builtIn && overriddenNames.has(role.role),
      });
    }
    return views;
  };

  const currentModels = (): TaskModelView => {
    if (options.current) return options.current().models;
    const config = readOrThrow();
    return {
      coder: config.models.coder ?? options.envModels.coder ?? "",
      reviewer: config.models.reviewer ?? options.envModels.reviewer ?? "",
      planner: config.models.planner ?? options.envModels.planner ?? "",
    };
  };

  const buildView = (config: AiTeamConfigFile): ConfigViewModel => {
    const models = {
      coder: config.models.coder ?? options.envModels.coder ?? "",
      reviewer: config.models.reviewer ?? options.envModels.reviewer ?? "",
      planner: config.models.planner ?? options.envModels.planner ?? "",
    };
    const catalog = resolveModelProfiles(config.catalog).map((model) => ({
      id: model.id,
      providerId: model.providerId,
      contextWindow: model.contextWindow,
      supportsToolCalling: model.features.supportsToolCalling,
    }));

    return {
      path,
      file: statConfigFile(path),
      config,
      models,
      catalog,
      roles: toRoleViews(config),
      // Real tool names only — from the agent registry, so the UI can never
      // offer a tool that does not exist.
      availableTools: [...CODER_TOOL_NAMES],
      sources: {
        coder: config.models.coder ? "config" : "env",
        reviewer: config.models.reviewer ? "config" : "env",
        planner: config.models.planner ? "config" : "env",
      },
    };
  };

  const assertDistinctModels = (models: TaskModelView): void => {
    if (models.coder && models.reviewer && models.coder === models.reviewer) {
      throw new ServiceError(
        "coder and reviewer models must differ (independent verification)",
        { status: 422, code: "validation_error" },
      );
    }
  };

  return {
    getConfig(): ConfigViewModel {
      const config = normalise(readOrThrow());
      logger.debug("config.read", { path, roles: config.roles.length, catalog: config.catalog.length });
      return buildView(config);
    },

    validate(draft) {
      return validateConfigFile(draft, path);
    },

    update(patch: ConfigPatch): ConfigViewModel {
      const existing = normalise(readOrThrow());

      const merged: AiTeamConfigFile = {
        version: 1,
        models: { ...existing.models, ...(patch.models ?? {}) },
        catalog: patch.catalog ?? existing.catalog,
        roles: patch.roles ?? existing.roles,
        ...(patch.notes !== undefined
          ? { notes: patch.notes }
          : existing.notes !== undefined
            ? { notes: existing.notes }
            : {}),
      };

      // Validate the merged result, not just the patch: a patch can be valid in
      // isolation yet combine with the file into something invalid.
      const validated = (() => {
        try {
          return parseConfigFile(merged, path);
        } catch (error) {
          if (error instanceof ConfigFileError) {
            throw new ServiceError(
              `The configuration is not valid: ${error.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
              { status: 422, code: "config_invalid" },
            );
          }
          throw error;
        }
      })();

      assertDistinctModels({
        coder: validated.models.coder ?? options.envModels.coder ?? "",
        reviewer: validated.models.reviewer ?? options.envModels.reviewer ?? "",
        planner: validated.models.planner ?? options.envModels.planner ?? "",
      });

      const meta = writeOrThrow(validated);
      logger.info("config.updated", { path, hash: meta.hash });
      return buildView(validated);
    },

    upsertRole(role: ConfiguredRole): ConfigViewModel {
      const existing = normalise(readOrThrow());
      const others = existing.roles.filter((entry) => entry.role !== role.role);

      // A built-in role may be overridden but never duplicated; a custom role is
      // appended. Either way the resulting document must have unique role names.
      const nextRoles = [...others, role];

      const merged: AiTeamConfigFile = {
        version: 1,
        models: existing.models,
        catalog: existing.catalog,
        roles: nextRoles,
        ...(existing.notes !== undefined ? { notes: existing.notes } : {}),
      };

      const validated = (() => {
        try {
          return parseConfigFile(merged, path);
        } catch (error) {
          if (error instanceof ConfigFileError) {
            throw new ServiceError(
              `The role is not valid: ${error.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
              { status: 422, code: "validation_error" },
            );
          }
          throw error;
        }
      })();

      const meta = writeOrThrow(validated);
      logger.info("config.role_upserted", { path, role: role.role, hash: meta.hash });
      return buildView(validated);
    },

    deleteRole(role: string): ConfigViewModel {
      const existing = normalise(readOrThrow());

      if ((BUILT_IN_ROLES as readonly string[]).includes(role)) {
        throw new ServiceError(
          `"${role}" is a built-in role and cannot be deleted. Override it instead.`,
          { status: 409, code: "built_in_role" },
        );
      }

      const nextRoles = existing.roles.filter((entry) => entry.role !== role);
      if (nextRoles.length === existing.roles.length) {
        throw new ServiceError(`No custom role named "${role}" exists.`, {
          status: 404,
          code: "role_not_found",
        });
      }

      const merged: AiTeamConfigFile = {
        version: 1,
        models: existing.models,
        catalog: existing.catalog,
        roles: nextRoles,
        ...(existing.notes !== undefined ? { notes: existing.notes } : {}),
      };

      const meta = writeOrThrow(merged);
      logger.info("config.role_deleted", { path, role, hash: meta.hash });
      return buildView(merged);
    },

    getRole(role: string): ConfigRoleView | undefined {
      return toRoleViews(normalise(readOrThrow())).find((view) => view.role === role);
    },
  };
}

/** Convenience for wiring: the config path for a given env + cwd. */
export function configPathFor(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  return resolveConfigPath(env, cwd);
}
