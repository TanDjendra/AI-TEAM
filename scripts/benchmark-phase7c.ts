import { execSync } from "node:child_process";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const tasks = ["TASK-SMALL", "TASK-MEDIUM", "TASK-LONG"];
const cwd = process.cwd();
const runsDir = join(cwd, ".runs");
const workspaceDir = join(cwd, "workspace");
const RUNS_PER_CONDITION = 3;

interface RunStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  duration: number;
  toolTurns: number;
  coderCalls: number;
  success: boolean;
}

interface AggregatedStats {
  inputTokens: { mean: number; median: number; min: number; max: number };
  outputTokens: { mean: number; median: number; min: number; max: number };
  totalTokens: { mean: number; median: number; min: number; max: number };
  duration: { mean: number; median: number; min: number; max: number };
  toolTurns: { mean: number; median: number; min: number; max: number };
  coderCalls: { mean: number; median: number; min: number; max: number };
  successRate: number; // percentage
}

function calculateStats(values: number[]): { mean: number; median: number; min: number; max: number } {
  if (values.length === 0) return { mean: 0, median: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  
  let median = 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    median = ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  } else {
    median = sorted[mid] ?? 0;
  }
  
  return { mean, median, min: min ?? 0, max: max ?? 0 };
}

function aggregateRuns(runs: RunStats[]): AggregatedStats {
  return {
    inputTokens: calculateStats(runs.map(r => r.inputTokens)),
    outputTokens: calculateStats(runs.map(r => r.outputTokens)),
    totalTokens: calculateStats(runs.map(r => r.totalTokens)),
    duration: calculateStats(runs.map(r => r.duration)),
    toolTurns: calculateStats(runs.map(r => r.toolTurns)),
    coderCalls: calculateStats(runs.map(r => r.coderCalls)),
    successRate: (runs.filter(r => r.success).length / runs.length) * 100
  };
}

function runSingle(taskName: string, enableCompaction: boolean, runIndex: number): RunStats {
  const targetWorkspace = join(workspaceDir, taskName);
  if (existsSync(targetWorkspace)) {
    rmSync(targetWorkspace, { recursive: true, force: true });
  }
  const runFile = join(runsDir, `${taskName}.json`);
  if (existsSync(runFile)) {
    rmSync(runFile, { force: true });
  }

  const env = { ...process.env };
  if (enableCompaction) {
    env["CONTEXT_COMPACTION_ENABLED"] = "true";
    env["CONTEXT_COMPACTION_RATIO"] = "0.75";
  } else {
    env["CONTEXT_COMPACTION_ENABLED"] = "false";
  }

  console.log(`  [Run ${runIndex}/${RUNS_PER_CONDITION}] Compaction: ${enableCompaction}`);
  try {
    execSync(`npx tsx src/cli.ts --task-file tests/benchmarks/${taskName}.json --json`, {
      env,
      stdio: "pipe",
    });
  } catch (error: any) {
    // some tasks might fail test/validation
  }

  if (!existsSync(runFile)) {
    throw new Error(`Run file not generated for ${taskName}`);
  }

  const data = JSON.parse(readFileSync(runFile, "utf-8"));
  
  const inputTokens = data.record.cycles.reduce((acc: number, c: any) => acc + (c.coder?.usage?.inputTokens || 0) + (c.reviewer?.usage?.inputTokens || 0), 0);
  const outputTokens = data.record.cycles.reduce((acc: number, c: any) => acc + (c.coder?.usage?.outputTokens || 0) + (c.reviewer?.usage?.outputTokens || 0), 0);
  
  return {
    inputTokens,
    outputTokens,
    totalTokens: data.summary.totalTokens,
    duration: data.summary.durationMs,
    toolTurns: data.record.cycles.reduce((acc: number, c: any) => acc + (c.coder?.executed_commands?.length || 0), 0),
    coderCalls: data.summary.coderCalls,
    success: data.summary.finalState === "DONE",
  };
}

function runBenchmark(taskName: string, enableCompaction: boolean): AggregatedStats {
  const runs: RunStats[] = [];
  for (let i = 1; i <= RUNS_PER_CONDITION; i++) {
    runs.push(runSingle(taskName, enableCompaction, i));
  }
  return aggregateRuns(runs);
}

function formatStat(stat: { mean: number; median: number; min: number; max: number }, isDuration = false): string {
  if (isDuration) {
    return `${(stat.mean/1000).toFixed(1)}s (med:${(stat.median/1000).toFixed(1)}s min:${(stat.min/1000).toFixed(1)}s max:${(stat.max/1000).toFixed(1)}s)`;
  }
  return `${stat.mean.toFixed(1)} (med:${stat.median.toFixed(1)} min:${stat.min} max:${stat.max})`;
}

console.log("Starting Phase 7C Benchmarks (3 runs per condition)...");
console.log("======================================================");

for (const task of tasks) {
  console.log(`\n--- Benchmarking ${task} ---`);
  
  console.log(`\n▶ BEFORE (No Compaction)`);
  const statsBefore = runBenchmark(task, false);
  
  console.log(`\n▶ AFTER (Adaptive Compaction)`);
  const statsAfter = runBenchmark(task, true);

  console.log(`\nRESULTS for ${task}:`);
  console.log(`| Metric       | BEFORE (No Compaction) | AFTER (Adaptive Compaction) | Difference (Mean) |`);
  console.log(`|--------------|-------------------------|-----------------------------|-------------------|`);
  console.log(`| Input Tokens | ${formatStat(statsBefore.inputTokens).padEnd(23)} | ${formatStat(statsAfter.inputTokens).padEnd(27)} | ${(statsAfter.inputTokens.mean - statsBefore.inputTokens.mean).toFixed(1)} |`);
  console.log(`| Output Tokens| ${formatStat(statsBefore.outputTokens).padEnd(23)} | ${formatStat(statsAfter.outputTokens).padEnd(27)} | ${(statsAfter.outputTokens.mean - statsBefore.outputTokens.mean).toFixed(1)} |`);
  console.log(`| Total Tokens | ${formatStat(statsBefore.totalTokens).padEnd(23)} | ${formatStat(statsAfter.totalTokens).padEnd(27)} | ${(statsAfter.totalTokens.mean - statsBefore.totalTokens.mean).toFixed(1)} |`);
  console.log(`| Duration     | ${formatStat(statsBefore.duration, true).padEnd(23)} | ${formatStat(statsAfter.duration, true).padEnd(27)} | ${((statsAfter.duration.mean - statsBefore.duration.mean) / 1000).toFixed(1)}s |`);
  console.log(`| Tool Turns   | ${formatStat(statsBefore.toolTurns).padEnd(23)} | ${formatStat(statsAfter.toolTurns).padEnd(27)} | ${(statsAfter.toolTurns.mean - statsBefore.toolTurns.mean).toFixed(1)} |`);
  console.log(`| Coder Calls  | ${formatStat(statsBefore.coderCalls).padEnd(23)} | ${formatStat(statsAfter.coderCalls).padEnd(27)} | ${(statsAfter.coderCalls.mean - statsBefore.coderCalls.mean).toFixed(1)} |`);
  console.log(`| Success Rate | ${statsBefore.successRate.toFixed(0).padEnd(23)}% | ${statsAfter.successRate.toFixed(0).padEnd(26)}% | ${(statsAfter.successRate - statsBefore.successRate).toFixed(0)}% |`);
}
