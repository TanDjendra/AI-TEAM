/**
 * Dashboard runtime singleton.
 *
 * Next.js evaluates route modules per request; the dashboard needs one
 * persistence stack, one event bus and one realtime hub for the whole process.
 * The instance is cached on `globalThis` so hot reload in dev does not create a
 * second pool or a second bus.
 *
 * Nothing here is fake: if neither DATABASE_URL nor PGLITE_DATA_DIR is set the
 * runtime reports itself as unconfigured and every API returns a clear "no
 * database" response instead of inventing data.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig, type AppConfig } from "../config/env.js";
import { createLogger, type Logger } from "../domain/logger.js";
import { createPersistence, loadPglite, type Persistence } from "../persistence/container.js";
import { createDashboardService, type DashboardService } from "./service.js";
import type { TaskSpec } from "../domain/types.js";
import type { TaskRecord } from "../persistence/repositories/task-repository.js";
import { createRuntime as createOrchestrationRuntime } from "../orchestration/container.js";
import { SingleProcessWorker, type TaskWorker } from "../orchestration/worker.js";
import { createRecoveryService, type RecoveryService } from "../orchestration/recovery.js";
import { createInterruptWatcher, type InterruptSignals } from "../orchestration/interrupt-listener.js";
import { createRealtimeHub, type RealtimeHub } from "./realtime.js";
import { StaleSweeper } from "../orchestration/sweeper.js";

export interface DashboardRuntime {
  configured: boolean;
  config: AppConfig;
  logger: Logger;
  persistence?: Persistence;
  hub: RealtimeHub;
  service?: DashboardService;
  sweeper?: StaleSweeper;
  workflowScheduler?: import("../orchestration/workflow-scheduler.js").WorkflowScheduler;
  /** Populated when the runtime could not be built. */
  error?: string;
}

export interface DashboardRuntimeOptions {
  config: AppConfig;
  logger: Logger;
  persistence?: Persistence;
  hub?: RealtimeHub;
  error?: string;
  /**
   * Injected control stack.
   *
   * Production omits this and lets the runtime build the real worker (which needs
   * a model provider). Tests inject a stub so HTTP behaviour can be exercised
   * deterministically without calling a model.
   */
  control?: {
    worker?: TaskWorker;
    recovery?: RecoveryService;
    loadSpec?(task: TaskRecord): Promise<TaskSpec>;
    staleThresholdMs?: number;
    plannerAgent?: import("../agents/planner-agent.js").PlannerAgent;
  };
}

export interface RealtimeTransportTarget {
  name: string;
  publish(event: unknown): Promise<void>;
}

/**
 * Assembles a runtime around an existing persistence stack.
 *
 * Shared by the production builder and the integration tests, so what the tests
 * exercise is the same wiring the server uses — not a parallel code path.
 */
export async function createDashboardRuntime(options: DashboardRuntimeOptions): Promise<DashboardRuntime> {
  const { config, logger } = options;
  const hub =
    options.hub ??
    createRealtimeHub({
      onError: (failure) =>
        logger.error("realtime.error", {
          stage: failure.stage,
          source: failure.source,
          error: failure.message,
        }),
    });

  if (!options.persistence) {
    return {
      configured: false,
      config,
      logger,
      hub,
      ...(options.error ? { error: options.error } : {}),
    };
  }

  const persistence = options.persistence;

  // PHASE 6: real control. `worker` is optional because building it needs a model
  // provider; when it cannot be built the service still serves reads and refuses
  // start/pause/cancel rather than pretending to control anything.
  const control = options.control
    ? {
        ...options.control,
        loadSpec: options.control.loadSpec ?? (async (task: TaskRecord) => ({ id: task.externalId, title: task.title, description: task.description })),
        staleThresholdMs: options.control.staleThresholdMs ?? config.orchestrator.staleRunThresholdMs,
      }
    : await buildControl(persistence, config, logger);

  const service = createDashboardService({
    persistence,
    logger,
    router: {
      baseUrl: config.router.baseUrl,
      coderModel: config.coder.model,
      reviewerModel: config.reviewer.model,
    },
    workspaceRoot: config.orchestrator.workspaceRoot || join(process.cwd(), "workspace"),
    ...(control.worker ? { worker: control.worker } : {}),
    ...(control.plannerAgent ? { plannerAgent: control.plannerAgent } : {}),
    ...(control.recovery ? { recovery: control.recovery } : {}),
    loadSpec: control.loadSpec,
    staleThresholdMs: control.staleThresholdMs,
  });

  return {
    configured: true,
    config,
    logger,
    persistence,
    hub,
    service,
    ...(control.worker ? { worker: control.worker } : {}),
    ...(control.recovery ? { recovery: control.recovery } : {}),
    ...("sweeper" in control && control.sweeper ? { sweeper: control.sweeper } : {}),
    ...("workflowScheduler" in control && control.workflowScheduler ? { workflowScheduler: control.workflowScheduler } : {}),
  };
}

/**
 * Builds the worker + recovery stack.
 *
 * The orchestrator is constructed here (no network calls happen at construction)
 * and shares the dashboard's persistence stack, so a run started from the browser
 * writes and streams through the same bus the browser is already reading.
 *
 * The file lookup for a task spec is intentionally part of this layer: a task file
 * carries the acceptance criteria the reviewer grades against, which the stored
 * row does not.
 */
async function buildControl(
  persistence: Persistence,
  config: AppConfig,
  logger: Logger,
): Promise<{
  worker?: TaskWorker;
  recovery?: RecoveryService;
  sweeper?: StaleSweeper;
  workflowScheduler?: import("../orchestration/workflow-scheduler.js").WorkflowScheduler;
  plannerAgent?: import("../agents/planner-agent.js").PlannerAgent;
  loadSpec: (task: TaskRecord) => Promise<TaskSpec>;
  staleThresholdMs: number;
}> {
  const staleThresholdMs = config.orchestrator.staleRunThresholdMs;

  const loadSpec = async (task: TaskRecord): Promise<TaskSpec> => {
    const cwd = process.cwd();
    for (const candidate of [
      join(cwd, "tasks", `${task.externalId}.json`),
      join(cwd, "tasks", `${task.externalId.toLowerCase()}.json`),
    ]) {
      try {
        const raw = await readFile(candidate, "utf8");
        const parsed = JSON.parse(raw) as TaskSpec;
        if (parsed?.id && parsed?.title && parsed?.description) return parsed;
      } catch {
        // try the next candidate, then fall back to the stored row
      }
    }
    return { id: task.externalId, title: task.title, description: task.description } satisfies TaskSpec;
  };

  const recovery = createRecoveryService({ persistence, logger, staleThresholdMs });

  // The watcher answers "did a human ask to stop?" from a short-lived cache, so
  // the orchestrator's safe-point check never blocks on the database.
  const watchers = new Map<string, InterruptSignals>();
  const watcherFor = async (externalId: string): Promise<InterruptSignals | undefined> => {
    const task = await persistence.repositories.tasks.findByExternalId(externalId);
    if (!task) return undefined;
    let watcher = watchers.get(externalId);
    if (!watcher) {
      watcher = createInterruptWatcher({ interrupts: persistence.repositories.interrupts, taskId: task.id });
      watchers.set(externalId, watcher);
    }
    return watcher;
  };

  let worker: TaskWorker | undefined;
  let plannerAgent: import("../agents/planner-agent.js").PlannerAgent | undefined;
  try {
    const runtime = await createOrchestrationRuntime({ existingPersistence: persistence });
    worker = new SingleProcessWorker({
      persistence,
      logger,
      orchestrator: runtime.orchestrator,
      heartbeatIntervalMs: config.orchestrator.heartbeatIntervalMs,
      interruptWatcherFor: (internalTaskId: string) =>
        createInterruptWatcher({
          interrupts: persistence.repositories.interrupts,
          taskId: internalTaskId,
        }),
    });

    const { PlannerAgent } = await import("../agents/planner-agent.js");
    plannerAgent = new PlannerAgent({
      modelProvider: runtime.provider,
    });
  } catch (error) {
    logger.error("control.worker_unavailable", {
      error: error instanceof Error ? error.message : String(error),
      note: "start/pause/cancel will be refused until this is resolved",
    });
  }

  const sweeper = new StaleSweeper({
    recovery,
    logger,
    intervalMs: config.orchestrator.staleSweepIntervalMs,
  });
  await sweeper.sweepOnce();
  sweeper.start();

  let workflowScheduler: import("../orchestration/workflow-scheduler.js").WorkflowScheduler | undefined;
  if (config.orchestrator.workflowEnabled && worker) {
    const { WorkflowScheduler } = await import("../orchestration/workflow-scheduler.js");
    workflowScheduler = new WorkflowScheduler({
      persistence,
      logger,
      worker,
      pollIntervalMs: 5000,
      workerPoolSize: config.orchestrator.workerPoolSize,
    });
    workflowScheduler.start();
  }

  return {
    ...(worker ? { worker } : {}),
    ...(plannerAgent ? { plannerAgent } : {}),
    recovery,
    sweeper,
    ...(workflowScheduler ? { workflowScheduler } : {}),
    loadSpec: async (task) => {
      // Register the watcher up front so the very first safe point can see a
      // pause requested microseconds after Start.
      await watcherFor(task.externalId).catch(() => undefined);
      return loadSpec(task);
    },
    staleThresholdMs,
  };
}

/** Resolves a task's interrupt watcher (used by the worker's poll). */
export async function interruptSignalsFor(
  persistence: Persistence,
  externalId: string,
): Promise<InterruptSignals | undefined> {
  const task = await persistence.repositories.tasks.findByExternalId(externalId);
  if (!task) return undefined;
  const watcher = createInterruptWatcher({
    interrupts: persistence.repositories.interrupts,
    taskId: task.id,
  });
  await watcher.refresh();
  return watcher;
}

interface GlobalCache {
  __aiTeamDashboardRuntime?: DashboardRuntime;
  __aiTeamDashboardPromise?: Promise<DashboardRuntime>;
}

const cache = globalThis as unknown as GlobalCache;

async function build(): Promise<DashboardRuntime> {
  const cwd = process.cwd();
  const config = loadConfig({ cwd, loadDotEnv: true });
  const logger = createLogger({
    level: config.logging.level,
    format: config.logging.format,
    base: { service: "ai-team-dashboard" },
  });

  const hub = createRealtimeHub({
    onError: (failure) =>
      logger.error("realtime.error", {
        stage: failure.stage,
        source: failure.source,
        error: failure.message,
      }),
  });

  if (!config.database.url && !config.database.pgliteDir) {
    logger.warn("dashboard.no_database", {
      note: "Neither DATABASE_URL nor PGLITE_DATA_DIR is set — the dashboard will report 'not configured' instead of showing data",
    });
    return { configured: false, config, logger, hub };
  }

  try {
    const persistence = await createPersistence({
      config,
      logger,
      pgliteLoader: loadPglite,
      transports: [
        // The persistence bus fans into the dashboard hub so a browser sees
        // events the orchestrator publishes in this process.
        {
          name: "dashboard-hub",
          publish: async (event) => {
            await hub.bus.publish(event);
          },
        },
      ],
    });

    if (!persistence) {
      return { configured: false, config, logger, hub, error: "persistence unavailable" };
    }

    const runtime = createDashboardRuntime({ config, logger, persistence, hub });

    logger.info("dashboard.ready", {
      router: config.router.baseUrl,
      coder: config.coder.model,
      reviewer: config.reviewer.model,
    });

    return runtime;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("dashboard.persistence_failed", { error: message });
    return { configured: false, config, logger, hub, error: message };
  }
}

/** Returns the process-wide runtime, building it once. */
export function getDashboardRuntime(): Promise<DashboardRuntime> {
  if (cache.__aiTeamDashboardRuntime) return Promise.resolve(cache.__aiTeamDashboardRuntime);
  if (!cache.__aiTeamDashboardPromise) {
    cache.__aiTeamDashboardPromise = build().then((runtime) => {
      cache.__aiTeamDashboardRuntime = runtime;
      cache.__aiTeamDashboardPromise = undefined;
      return runtime;
    });
  }
  return cache.__aiTeamDashboardPromise;
}

/** Test seam: forget the cached runtime. */
export function resetDashboardRuntime(): void {
  cache.__aiTeamDashboardRuntime = undefined;
  cache.__aiTeamDashboardPromise = undefined;
}

/**
 * Test seam: install an already-built runtime.
 *
 * Integration tests point the real HTTP handlers at a real PostgreSQL (PGlite)
 * without going through `.env` discovery.
 */
export function installDashboardRuntime(runtime: DashboardRuntime): void {
  cache.__aiTeamDashboardRuntime = runtime;
  cache.__aiTeamDashboardPromise = undefined;
}
