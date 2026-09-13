#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   npm run router:check
 *   npm run task                       # tasks/TASK-001.json
 *   npm run task -- --task-file path/to/task.json
 *   npm run task -- --json             # machine-readable stdout
 *
 * Exit code: 0 = DONE (approved), 2 = NEEDS_HUMAN, 1 = usage/infrastructure error.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadConfig } from "./config/env.js";
import { createLogger } from "./domain/logger.js";
import type { TaskSpec } from "./domain/types.js";
import { createRuntime } from "./orchestration/container.js";
import { renderRunReport, summarizeRun } from "./orchestration/report.js";

const EXIT_DONE = 0;
const EXIT_NEEDS_HUMAN = 2;
const EXIT_ERROR = 1;

interface CliArgs {
  checkRouter: boolean;
  checkDb: boolean;
  taskFile?: string;
  json: boolean;
  cwd: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { checkRouter: false, checkDb: false, json: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check-router") args.checkRouter = true;
    else if (arg === "--check-db") args.checkDb = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--task-file") args.taskFile = argv[++i];
    else if (arg?.startsWith("--task-file=")) args.taskFile = arg.slice("--task-file=".length);
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(EXIT_DONE);
    }
  }
  return args;
}

function printUsage(): void {
  process.stdout.write(
    [
      "AI Team Orchestrator",
      "",
      "Usage:",
      "  tsx src/cli.ts --check-router         Verify 9Router reachability, models and credentials",
      "  tsx src/cli.ts --check-db             Verify the database, migrations and schema",
      "  tsx src/cli.ts [--task-file <path>]   Run a task (default tasks/TASK-001.json)",
      "  tsx src/cli.ts --json                 Emit the run summary as JSON on stdout",
      "",
      "Persistence is enabled by setting DATABASE_URL (Postgres or Supabase Postgres).",
      "Without it the orchestrator runs in memory and events are not stored.",
      "",
    ].join("\n"),
  );
}

async function readTaskSpec(path: string): Promise<TaskSpec> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<TaskSpec>;
  if (!parsed.id || !parsed.title || !parsed.description) {
    throw new Error(`Task file ${path} must contain at least id, title and description`);
  }
  return {
    id: parsed.id,
    title: parsed.title,
    description: parsed.description,
    ...(parsed.acceptanceCriteria ? { acceptanceCriteria: parsed.acceptanceCriteria } : {}),
    ...(parsed.workspaceSlug ? { workspaceSlug: parsed.workspaceSlug } : {}),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // Config is validated before any logger is built, so bad env fails loudly
  // rather than being reported through a logger that may itself be misconfigured.
  const config = loadConfig({ cwd: args.cwd });
  const logger = createLogger({
    level: config.logging.level,
    format: config.logging.format,
    base: { service: "ai-team-orchestrator", cli: true },
  });

  const runtime = await createRuntime({ cwd: args.cwd, logger });

  if (args.checkDb) {
    const persistence = runtime.persistence;
    if (!persistence) {
      process.stdout.write(
        `${JSON.stringify(
          {
            configured: false,
            note: "DATABASE_URL is not set; persistence is disabled and events are not stored.",
          },
          null,
          2,
        )}\n`,
      );
      return EXIT_ERROR;
    }

    const { schemaIsReady, MIGRATIONS_TABLE } = await import("./persistence/migrate.js");
    const ready = await schemaIsReady(persistence.db);
    const applied = await persistence.db.query<{ name: string }>(
      `select name from ${MIGRATIONS_TABLE} order by name`,
    );
    const counts = await persistence.db.query<{ table_name: string; n: string }>(
      `select 'tasks' as table_name, count(*)::text as n from tasks
       union all select 'task_runs', count(*)::text from task_runs
       union all select 'reviews', count(*)::text from reviews
       union all select 'activity_logs', count(*)::text from activity_logs
       union all select 'tool_calls', count(*)::text from tool_calls
       union all select 'file_changes', count(*)::text from file_changes
       union all select 'test_results', count(*)::text from test_results
       union all select 'agents', count(*)::text from agents`,
    );

    const report = {
      configured: true,
      schemaReady: ready,
      migrations: applied.map((row) => row.name),
      rowCounts: Object.fromEntries(counts.map((row) => [row.table_name, Number(row.n)])),
      warnings: persistence.warnings,
      ok: ready,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await runtime.close();
    return report.ok ? EXIT_DONE : EXIT_ERROR;
  }

  if (args.checkRouter) {
    const health = await runtime.provider.health();
    const models = await runtime.verifyModels();
    const credentials = await runtime.verifyCredentials();
    const report = {
      router: health,
      configured: {
        coder: runtime.config.coder.model,
        reviewer: runtime.config.reviewer.model,
      },
      modelsServed: models.available,
      missing: models.missing,
      credentials,
      // `health.ok` is NOT enough: 9Router serves GET /v1/models without auth,
      // so the credentials probe is what actually decides readiness.
      ok: health.ok && models.ok && credentials.ok,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? EXIT_DONE : EXIT_ERROR;
  }

  const taskPath = resolve(args.taskFile ?? join(args.cwd, "tasks", "TASK-001.json"));
  const spec = await readTaskSpec(taskPath);

  logger.info("task.loaded", { path: taskPath, id: spec.id, title: spec.title });

  const record = await runtime.orchestrator.run(spec);
  const summary = summarizeRun(record, runtime.config.orchestrator.maxReviewCycles);

  // Persist run artefacts next to the workspace for post-mortems.
  const runsDir = join(args.cwd, ".runs");
  await mkdir(runsDir, { recursive: true });
  const jsonPath = join(runsDir, `${spec.id}.json`);
  await writeFile(jsonPath, `${JSON.stringify({ summary, record }, null, 2)}\n`, "utf8");
  const reportPath = join(runsDir, `${spec.id}.md`);
  await writeFile(reportPath, `${renderRunReport(record, runtime.config.orchestrator.maxReviewCycles)}\n`, "utf8");

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ summary, artifacts: { json: jsonPath, report: reportPath } }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderRunReport(record, runtime.config.orchestrator.maxReviewCycles)}\n`);
    process.stdout.write(`\nArtifacts: ${jsonPath}\n           ${reportPath}\n`);
  }

  await runtime.close();
  return summary.finalState === "DONE" ? EXIT_DONE : EXIT_NEEDS_HUMAN;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nFATAL: ${message}\n`);
    // Stack traces are developer detail, not user-facing output. Only show one
    // when the operator has explicitly asked for debug-level logging.
    const debugEnabled = (process.env.LOG_LEVEL ?? "").toLowerCase() === "debug";
    if (debugEnabled && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = EXIT_ERROR;
  });

export { main };
