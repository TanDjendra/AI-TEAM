import { performance } from "perf_hooks";
import { WorkerPool } from "../src/orchestration/worker-pool.js";
import { createLogger } from "../src/domain/logger.js";

const logger = createLogger({ level: "error", format: "text", base: { service: "benchmark" } });

// Simulate a worker that takes 100ms to process a task
function createMockTask(taskId: string, durationMs: number = 100) {
  return async () => {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
  };
}

async function runSequential(taskCount: number, taskDurationMs: number): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < taskCount; i++) {
    await new Promise((resolve) => setTimeout(resolve, taskDurationMs));
  }
  return performance.now() - start;
}

async function runParallel(taskCount: number, taskDurationMs: number, poolSize: number): Promise<number> {
  const start = performance.now();
  let completed = 0;
  let nextTaskIndex = 0;
  let resolveFinish!: () => void;
  const finishPromise = new Promise<void>((res) => { resolveFinish = res; });

  const pool = new WorkerPool({
    poolSize,
    pollIntervalMs: 10, // fast poll
    logger,
    tryClaimWork: async () => {
      if (nextTaskIndex >= taskCount) return null;
      const index = nextTaskIndex++;
      
      return {
        laneLifetime: new Promise<void>((resolveLane) => {
          setTimeout(() => {
            completed++;
            resolveLane();
            if (completed >= taskCount) {
              resolveFinish();
            }
          }, taskDurationMs);
        })
      };
    }
  });

  pool.start();
  await finishPromise;
  await pool.stop();
  return performance.now() - start;
}

async function main() {
  const TASK_COUNT = 20;
  const TASK_DURATION_MS = 200; // Simulated LLM task execution time

  console.log("Starting Phase V2-11 Benchmark (DAG Parallel Execution)");
  console.log("=======================================================");
  console.log(`Workload: ${TASK_COUNT} tasks, ~${TASK_DURATION_MS}ms per task\n`);

  console.log("▶ BEFORE (V1 Sequential / Pool Size = 1)");
  const sequentialTime = await runSequential(TASK_COUNT, TASK_DURATION_MS);
  console.log(`  Duration: ${(sequentialTime / 1000).toFixed(2)}s\n`);

  console.log("▶ AFTER (V2 Parallel / Pool Size = 4)");
  const parallelTime = await runParallel(TASK_COUNT, TASK_DURATION_MS, 4);
  console.log(`  Duration: ${(parallelTime / 1000).toFixed(2)}s\n`);

  console.log("▶ AFTER (V2 Parallel / Pool Size = 8)");
  const parallelTime8 = await runParallel(TASK_COUNT, TASK_DURATION_MS, 8);
  console.log(`  Duration: ${(parallelTime8 / 1000).toFixed(2)}s\n`);

  console.log("RESULTS SUMMARY:");
  console.log(`| Metric       | BEFORE (Sequential) | AFTER (4 Workers) | AFTER (8 Workers) |`);
  console.log(`|--------------|---------------------|-------------------|-------------------|`);
  console.log(`| Duration     | ${(sequentialTime / 1000).toFixed(2)}s               | ${(parallelTime / 1000).toFixed(2)}s             | ${(parallelTime8 / 1000).toFixed(2)}s             |`);
  console.log(`| Speedup      | 1.00x               | ${(sequentialTime / parallelTime).toFixed(2)}x             | ${(sequentialTime / parallelTime8).toFixed(2)}x             |`);
}

main().catch(console.error);
