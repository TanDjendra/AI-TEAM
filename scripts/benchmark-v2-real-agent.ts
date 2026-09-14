import { resolve, join } from "node:path";
import { rm } from "node:fs/promises";
import { performance } from "perf_hooks";

import { createRuntime } from "../src/orchestration/container.js";
import { createLogger } from "../src/domain/logger.js";
import { loadConfig } from "../src/config/env.js";

import { createDashboardService } from "../src/dashboard/service.js";

async function pollTaskDone(service: any, taskId: string): Promise<string> {
  while (true) {
    const task = await service.getTask(taskId);
    if (["DONE", "NEEDS_HUMAN", "FAILED", "CANCELLED"].includes(task?.status)) {
      return task.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function pollWorkflowDone(service: any, workflowId: string): Promise<string> {
  while (true) {
    const wf = await service.getWorkflow(workflowId);
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(wf?.status)) {
      return wf.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function main() {
  console.log("Booting Orchestrator Runtime...");
  const cwd = process.cwd();
  const customEnv = { ...process.env, WORKFLOW_ENABLED: "true" };
  const config = loadConfig({ 
    cwd,
    env: customEnv
  });
  const logger = createLogger({ level: "info", format: "text", base: { service: "real-benchmark" } });
  
  const runtime = await createRuntime({ cwd, logger, env: customEnv });
  const { PlannerAgent } = await import("../src/agents/planner-agent.js");
  const plannerAgent = new PlannerAgent({
    modelProvider: runtime.provider,
  });

  const service = createDashboardService({
    persistence: runtime.persistence!,
    provider: runtime.provider,
    plannerAgent,
    logger
  });
  const testWorkspace = resolve(join(cwd, "workspace", "benchmark-real"));

  const taskDescription = `Write three independent Python scripts:
1. sort.py - A script with a function that sorts a list of numbers using bubble sort.
2. search.py - A script with a function that performs binary search on a sorted list.
3. math_utils.py - A script with a function that calculates the factorial of a number.
Make sure to create all three files independently.`;

  console.log("\nStarting V1 vs V2 Benchmark with REAL AGENTS (9Router)");
  console.log("=========================================================");
  console.log("Task Description:", taskDescription.replace(/\n/g, " "));

  try {
    // 1. Benchmark V1 (Sequential Coder)
    console.log("\n▶ BEFORE (V1 - Single Task, No AutoPlan)");
    await rm(testWorkspace, { recursive: true, force: true }).catch(() => {});
    
    const startV1 = performance.now();
    const taskV1 = await service.createTask({
      title: "V1 Sequential Test",
      description: taskDescription,
      workspace: testWorkspace,
      autoPlan: false,
      maxReviewCycles: 3,
    });
    console.log(`  Submitted Task V1: ${taskV1.id}`);
    
    const statusV1 = await pollTaskDone(service, taskV1.id);
    const timeV1 = performance.now() - startV1;
    console.log(`  V1 Completed with status: ${statusV1} in ${(timeV1 / 1000).toFixed(2)}s`);

    // 2. Benchmark V2 (AutoPlan Workflow)
    console.log("\n▶ AFTER (V2 - AutoPlan Workflow, Parallel DAG)");
    await rm(testWorkspace, { recursive: true, force: true }).catch(() => {});
    
    const startV2 = performance.now();
    const resultV2 = await service.createTask({
      title: "V2 Parallel Test",
      description: taskDescription,
      workspace: testWorkspace,
      autoPlan: true,
      maxReviewCycles: 3,
    }) as any;
    const workflowId = resultV2.workflowId;
    console.log(`  Workflow Created: ${workflowId}`);

    const statusV2 = await pollWorkflowDone(service, workflowId);
    const timeV2 = performance.now() - startV2;
    console.log(`  V2 Completed with status: ${statusV2} in ${(timeV2 / 1000).toFixed(2)}s`);

    console.log("\n=========================================================");
    console.log("BENCHMARK RESULTS");
    console.log(`V1 (Sequential) Status : ${statusV1}`);
    console.log(`V1 (Sequential) Time   : ${(timeV1 / 1000).toFixed(2)}s`);
    console.log(`V2 (Parallel DAG) Status : ${statusV2}`);
    console.log(`V2 (Parallel DAG) Time   : ${(timeV2 / 1000).toFixed(2)}s`);
    console.log("=========================================================\n");
    console.log(`| Metric       | BEFORE (V1 Sequential) | AFTER (V2 Parallel) |`);
    console.log(`|--------------|------------------------|---------------------|`);
    console.log(`| Duration     | ${(timeV1 / 1000).toFixed(2)}s                  | ${(timeV2 / 1000).toFixed(2)}s                |`);
    console.log(`| Speedup      | 1.00x                  | ${(timeV1 / timeV2).toFixed(2)}x                |`);
    
  } catch (error: any) {
    console.error("\nFATAL ERROR:", error.message);
  } finally {
    await runtime.close();
  }
}

main().catch(console.error);
