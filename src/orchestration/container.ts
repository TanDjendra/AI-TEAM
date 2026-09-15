/**
 * Composition root: reads configuration, builds the real 9Router provider and
 * binds the agents to a workspace.
 *
 * This is the only place where a concrete provider is chosen. Everything
 * downstream depends on interfaces only.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { describeConfig, loadConfig, type AppConfig, type LoadConfigOptions } from "../config/env.js";
import { CoderAgent } from "../agents/coder-agent.js";
import { ReviewerAgent } from "../agents/reviewer-agent.js";
import { CommandRunner } from "../agents/tools.js";
import { Workspace } from "../agents/workspace.js";
import { DefaultBudgetAuthorizer, NoopBudgetAuthorizer } from "../services/budget-authorizer.js";
import { ExecutionWorkspaceResolver } from "./execution-workspace.js";
import { GitWorktreeManager } from "./git-worktree-manager.js";
import { createLogger, type Logger } from "../domain/logger.js";
import type { Agent } from "../domain/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { EventTransport } from "../events/bus.js";
import { RouterProvider } from "../providers/router-provider.js";
import { OrchestratorService, CODER_AGENT_KEY, REVIEWER_AGENT_KEY } from "./runner.js";
import { createPersistenceHooks } from "./persistence-hooks.js";
import { createPersistence, loadPglite, type Persistence } from "../persistence/container.js";
import { SingleProcessWorker, type TaskWorker } from "./worker.js";
import { WorkflowScheduler } from "./workflow-scheduler.js";
import { WorkflowPlanner } from "./workflow-planner.js";
import { IntegrationCoordinator } from "./integration-coordinator.js";

export interface RuntimeOptions {
  /** Defaults to process.cwd(). */
  cwd?: string;
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /** Injected for tests; defaults to the real 9Router HTTP provider. */
  provider?: ModelProvider;
  /** Injected for tests; defaults to a real CommandRunner. */
  runner?: CommandRunner;
  configOverrides?: Partial<LoadConfigOptions>;
  /** Extra event transports (a dashboard's own sink, typically). */
  persistence?: { transports?: EventTransport[] };
  /**
   * Reuse an existing persistence stack instead of opening one.
   *
   * Required when the caller already owns the database: the embedded Postgres
   * (PGlite) is single-instance per path, so opening a second one in the same
   * process is not possible. The dashboard passes its stack here so a task it
   * runs persists and streams through the exact bus the browser is reading.
   */
  existingPersistence?: Persistence;
}

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  provider: ModelProvider;
  orchestrator: OrchestratorService;
  /** Present only when a database is configured. */
  persistence?: Persistence;
  worker?: TaskWorker;
  scheduler?: WorkflowScheduler;
  planner?: WorkflowPlanner;
  integrationCoordinator?: IntegrationCoordinator;
  /** Resolves (and creates) the sandbox for a task slug. */
  resolveWorkspace(slug: string): Workspace;
  /** Verifies that both configured models are actually served by the router. */
  verifyModels(): Promise<{ ok: boolean; missing: string[]; available: number }>;
  /**
   * Proves the credentials work by issuing a real completion for each model.
   * Unlike `verifyModels()`, this cannot pass with a missing/invalid API key.
   */
  verifyCredentials(): Promise<{ ok: boolean; skipped: boolean; detail: string[] }>;
  close(): Promise<void>;
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig({
    cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.configOverrides ?? {}),
  });

  const logger =
    options.logger ??
    createLogger({
      level: config.logging.level,
      format: config.logging.format,
      base: { service: "ai-team-orchestrator" },
    });

  const provider =
    options.provider ??
    new RouterProvider({
      baseUrl: config.router.baseUrl,
      apiKey: config.router.apiKey,
      timeoutMs: config.router.timeoutMs,
      maxRetries: config.router.maxRetries,
    });

  const runner = options.runner ?? new CommandRunner();

  logger.info("config.loaded", describeConfig(config));

  const workspaceCache = new Map<string, Workspace>();
  const resolveWorkspace = (slug: string): Workspace => {
    const cached = workspaceCache.get(slug);
    if (cached) return cached;
    const ws = new Workspace(join(config.orchestrator.workspaceRoot, slug));
    workspaceCache.set(slug, ws);
    return ws;
  };

  // Persistence is optional: with no DATABASE_URL it returns undefined and the
  // orchestrator runs exactly as before (in-memory only). A caller that already
  // owns a stack (the dashboard) hands it in — the embedded database cannot be
  // opened twice in one process.
  let persistence: Persistence | undefined = options.existingPersistence;
  if (!persistence) {
    try {
      persistence = await createPersistence({
        config,
        logger,
        // Enables the embedded-Postgres path when PGLITE_DATA_DIR is set.
        pgliteLoader: loadPglite,
        ...(options.persistence ? { transports: options.persistence.transports } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("persistence.unavailable", { error: message });
      throw error;
    }
  }

  const hooksFactory = persistence
    ? () => createPersistenceHooks({
        bus: persistence.bus,
        recorder: persistence.recorder,
        repositories: persistence.repositories,
        logger,
        runKey: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        provider: "9router",
        models: { coder: config.coder.model, reviewer: config.reviewer.model },
      })
    : undefined;

  const orchestrator = new OrchestratorService({
    provider,
    config,
    logger,
    createCoder: (workspace, observer) => {
      const authorizer = persistence 
        ? new DefaultBudgetAuthorizer(persistence.usageLedger, config.orchestrator.maxTaskTokens ?? Infinity)
        : new NoopBudgetAuthorizer();
      return new CoderAgent({
        provider,
        model: config.coder.model,
        agentProfile: config.coder.agentProfile,
        modelProfile: config.coder.modelProfile,
        workspace,
        logger: logger.child({ model_role: "coder" }),
        runner,
        contextCompactionEnabled: config.orchestrator.contextCompactionEnabled,
        contextCompactionRatio: config.orchestrator.contextCompactionRatio,
        modelContextWindow: config.orchestrator.modelContextWindow,
        observer,
        authorizer,
      });
    },
    createReviewer: (workspace, observer) => {
      const authorizer = persistence 
        ? new DefaultBudgetAuthorizer(persistence.usageLedger, config.orchestrator.maxTaskTokens ?? Infinity)
        : new NoopBudgetAuthorizer();
      return new ReviewerAgent({
        provider,
        model: config.reviewer.model,
        agentProfile: config.reviewer.agentProfile,
        modelProfile: config.reviewer.modelProfile,
        logger: logger.child({ model_role: "reviewer" }),
        observer,
        authorizer,
      });
    },
    workspaceResolver: new ExecutionWorkspaceResolver(
      config.orchestrator.workspaceRoot,
      logger,
      config.orchestrator.gitWorkspaceEnabled ? new GitWorktreeManager(config.orchestrator.workspaceRoot, logger) : undefined
    ),
    ...(hooksFactory ? { hooksFactory } : {}),
    ...(persistence
      ? {
          resolveAgentIds: async () => persistence.agentIds,
          // A task must not look complete when its record was not stored.
          ...(config.database.requirePersistence
            ? {
                completionBlocker: () => {
                  if (persistence.recorder.hasFatalFailure()) {
                    const [first] = persistence.recorder.failures();
                    return `persistence failure: ${first?.message ?? "unknown"}`;
                  }
                  return undefined;
                },
              }
            : {}),
        }
      : {}),
  });

  const verifyModels: Runtime["verifyModels"] = async () => {
    const available = await provider.listModels();
    const subscribed = [config.coder.model, config.reviewer.model];
    const missing = subscribed.filter((model) => !available.includes(model));
    return { ok: missing.length === 0, missing, available: available.length };
  };

  const verifyCredentials: Runtime["verifyCredentials"] = async () => {
    if (typeof provider.verifyChat !== "function") {
      return {
        ok: true,
        skipped: true,
        detail: ["provider does not implement verifyChat(); credentials were not proven"],
      };
    }

    const detail: string[] = [];
    let ok = true;
    for (const [role, model] of [
      ["coder", config.coder.model],
      ["reviewer", config.reviewer.model],
    ] as const) {
      const result = await provider.verifyChat(model);
      detail.push(
        `${role} ${model}: ${result.ok ? "ok" : `FAILED (${result.error ?? "unknown error"})`}`,
      );
      if (!result.ok) ok = false;
    }
    return { ok, skipped: false, detail };
  };

  if (config.router.verifyOnStart) {
    const health = await provider.health();
    if (!health.ok) {
      logger.error("router.unreachable", { baseUrl: health.baseUrl, error: health.error });
      throw new Error(
        `9Router is not reachable at ${health.baseUrl}: ${health.error ?? "unknown error"}`,
      );
    }
    const models = await verifyModels();
    logger.info("router.verified", {
      baseUrl: health.baseUrl,
      models: models.available,
      missing: models.missing,
    });
    if (!models.ok) {
      throw new Error(
        `The 9Router instance does not serve the configured model(s): ${models.missing.join(", ")}`,
      );
    }

    // Model listing is unauthenticated on 9Router, so a real completion is the
    // only way to prove the key works before accepting work.
    const credentials = await verifyCredentials();
    logger.info("router.credentials", { ok: credentials.ok, detail: credentials.detail });
    if (!credentials.ok) {
      throw new Error(`9Router credentials failed: ${credentials.detail.join("; ")}`);
    }
  }

  let worker: TaskWorker | undefined;
  let scheduler: WorkflowScheduler | undefined;
  let integrationCoordinator: IntegrationCoordinator | undefined;
  
  if (persistence) {
    worker = new SingleProcessWorker({
      persistence,
      orchestrator,
      logger,
      // Optional: checkInterrupt and interruptWatcherFor can be wired if needed,
      // but for V2-08 baseline, we can use the defaults.
    });

    let integrationCoordinator: IntegrationCoordinator | undefined;
    if (persistence.integrationCandidates) {
      integrationCoordinator = new IntegrationCoordinator(
        config.orchestrator.workspaceRoot,
        persistence.integrationCandidates,
        persistence.bus,
        logger
      );
    }

    scheduler = new WorkflowScheduler({
      persistence,
      worker,
      logger,
      integrationCoordinator,
    });
  }

  const planner = new WorkflowPlanner({
    modelProvider: provider,
    modelId: config.planner.model,
  });

  return {
    config,
    logger,
    provider,
    orchestrator,
    ...(persistence ? { persistence } : {}),
    ...(worker ? { worker } : {}),
    ...(scheduler ? { scheduler } : {}),
    ...(integrationCoordinator ? { integrationCoordinator } : {}),
    planner,
    resolveWorkspace,
    verifyModels,
    verifyCredentials,
    close: async () => {
      workspaceCache.clear();
      await scheduler?.stop();
      await worker?.shutdown();
      await persistence?.close();
    },
  };
}
