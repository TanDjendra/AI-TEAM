import { createRuntime } from "../orchestration/container.js";
import { SingleProcessWorker } from "../orchestration/worker.js";
import { QueueWorker } from "../orchestration/queue-worker.js";
import { StaleSweeper } from "../orchestration/sweeper.js";
import { createRecoveryService } from "../orchestration/recovery.js";

async function main() {
  const runtime = await createRuntime({ cwd: process.cwd() });
  const { logger, persistence, orchestrator, config } = runtime;

  if (!persistence) {
    logger.error("worker.no_persistence", { message: "Persistence is disabled or missing DB config. Worker cannot run." });
    process.exit(1);
  }

  logger.info("worker.booting", { pid: process.pid });

  // Register worker node in DB
  const workerNode = await persistence.workers.register(process.pid);
  logger.info("worker.registered", { workerId: workerNode.id, pid: process.pid });

  const singleWorker = new SingleProcessWorker({
    persistence,
    orchestrator,
    logger,
  });

  const recovery = createRecoveryService({ persistence, logger });
  const sweeper = new StaleSweeper({
    recovery,
    logger,
    intervalMs: 300_000, // Sweep every 5 minutes
  });

  const queueWorker = new QueueWorker({
    persistence,
    logger,
    worker: singleWorker,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || "1", 10),
    pollIntervalMs: parseInt(process.env.WORKER_POLL_INTERVAL_MS || "5000", 10),
  });

  // Startup Recovery
  logger.info("worker.startup_recovery", { message: "Running initial stale run sweep" });
  await sweeper.sweepOnce();
  
  // Start the background sweeper loop
  sweeper.start();

  // Start the Queue Worker loop
  queueWorker.start();

  // Heartbeat loop for the worker node
  const workerHeartbeat = setInterval(() => {
    persistence.workers.heartbeat(workerNode.id).catch((err) => {
      logger.error("worker.heartbeat_failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }, 10_000);

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info("worker.shutdown_initiated", { signal });
    
    // Set status to STOPPING
    await persistence.workers.heartbeat(workerNode.id, "STOPPING").catch(() => {});
    
    clearInterval(workerHeartbeat);
    sweeper.stop();
    await queueWorker.stop();
    
    // Set status to STOPPED
    await persistence.workers.heartbeat(workerNode.id, "STOPPED").catch(() => {});
    
    await runtime.close();
    logger.info("worker.shutdown_complete", {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Worker failed to start:", error);
  process.exit(1);
});
