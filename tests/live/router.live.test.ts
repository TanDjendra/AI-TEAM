/**
 * LIVE tests against the real 9Router instance.
 *
 * Enabled only with RUN_LIVE=1, because they need a running router, a real API
 * key and real credits. They are the proof that this project integrates 9Router
 * for real and that both configured models answer in the required contract.
 *
 *   RUN_LIVE=1 npx vitest run tests/live
 */

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/env.js";
import { createLogger } from "../../src/domain/logger.js";
import type { CoderOutput, TaskSpec } from "../../src/domain/types.js";
import { CoderAgent } from "../../src/agents/coder-agent.js";
import { CommandRunner } from "../../src/agents/tools.js";
import { Workspace } from "../../src/agents/workspace.js";
import { RouterProvider } from "../../src/providers/router-provider.js";
import { createRuntime } from "../../src/orchestration/container.js";
import { renderRunReport } from "../../src/orchestration/report.js";

const RUN_LIVE = process.env.RUN_LIVE === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const LIVE_TASK: TaskSpec = {
  id: "TASK-LIVE-001",
  title: "Create a slugify module with tests",
  description: [
    "In the workspace, create a small Node.js ESM package:",
    "- package.json with \"type\": \"module\" and a \"test\" script using `node --test`",
    "- src/index.js exporting slugify(input) and wordCount(input)",
    "- test/index.test.js with real tests",
    "slugify: lowercase, trim, collapse runs of non-alphanumeric characters into a single hyphen, strip leading/trailing hyphens; empty input returns \"\".",
    "wordCount: number of whitespace-separated tokens in the trimmed input; empty input returns 0.",
    "Run `npm test` and confirm it passes.",
  ].join("\n"),
  acceptanceCriteria: [
    "package.json defines a working test script",
    "src/index.js exports slugify and wordCount",
    "tests exist and cover empty input and punctuation",
    "the test command exits 0",
  ],
};

describeLive("live 9Router integration", () => {
  let config: ReturnType<typeof loadConfig>;
  let provider: RouterProvider;

  beforeAll(() => {
    config = loadConfig({ cwd: PROJECT_ROOT });
    provider = new RouterProvider({
      baseUrl: config.router.baseUrl,
      apiKey: config.router.apiKey,
      timeoutMs: config.router.timeoutMs,
      maxRetries: config.router.maxRetries,
    });
  });

  it(
    "reaches the router and lists models",
    async () => {
      const health = await provider.health();
      expect(health.ok, `router unreachable: ${health.error ?? ""}`).toBe(true);
      expect(health.modelCount ?? 0).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "proves the credentials work (health() alone cannot — /v1/models is unauthenticated)",
    async () => {
      const health = await provider.health();
      // Documents the trap: reachability does NOT imply valid credentials.
      expect(health.authVerified).toBe(false);

      const coderAuth = await provider.verifyChat(config.coder.model);
      expect(coderAuth.ok, `coder credentials rejected: ${coderAuth.error ?? ""}`).toBe(true);
      expect(coderAuth.authVerified).toBe(true);

      const reviewerAuth = await provider.verifyChat(config.reviewer.model);
      expect(reviewerAuth.ok, `reviewer credentials rejected: ${reviewerAuth.error ?? ""}`).toBe(true);
    },
    180_000,
  );

  it(
    "rejects a request with no API key (proving auth IS enforced on chat)",
    async () => {
      const anonymous = new RouterProvider({
        baseUrl: config.router.baseUrl,
        apiKey: "definitely-not-a-valid-key",
        maxRetries: 0,
      });
      const result = await anonymous.verifyChat(config.coder.model);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/401|Unauthorized/i);
    },
    120_000,
  );

  it(
    "serves both configured models",
    async () => {
      const models = await provider.listModels();
      expect(models).toContain(config.coder.model);
      expect(models).toContain(config.reviewer.model);
    },
    60_000,
  );

  it(
    "returns a plain completion from the coder model",
    async () => {
      const response = await provider.chat({
        model: config.coder.model,
        messages: [{ role: "user", content: "Reply with exactly: PONG" }],
        maxTokens: 64,
      });
      expect(response.content.toUpperCase()).toContain("PONG");
      expect(response.requestedModel).toBe(config.coder.model);
    },
    120_000,
  );

  it(
    "returns a JSON review verdict from the reviewer model",
    async () => {
      const response = await provider.chat({
        model: config.reviewer.model,
        messages: [
          {
            role: "user",
            content:
              'Reply with ONLY this JSON: {"verdict":"APPROVED","summary":"ok","issues":[],"required_fixes":[],"severity":"NONE"}',
          },
        ],
        json: true,
        maxTokens: 200,
      });
      expect(response.content).toContain("APPROVED");
      expect(response.resolvedModel).toBeTruthy();
    },
    120_000,
  );

  it(
    "streams deltas from the coder model",
    async () => {
      const deltas: string[] = [];
      const iterator = provider.chatStream({
        model: config.coder.model,
        messages: [{ role: "user", content: "Count from 1 to 3 with spaces." }],
        maxTokens: 64,
      });

      let step = await iterator.next();
      while (!step.done) {
        if (step.value.delta) deltas.push(step.value.delta);
        step = await iterator.next();
      }

      expect(deltas.length).toBeGreaterThan(0);
      expect(step.value.content.length).toBeGreaterThan(0);
    },
    120_000,
  );
});

describeLive("live agent run", () => {
  it(
    "runs the real CoderAgent against the real router and verifies its own claims",
    async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "ai-team-live-"));
      const workspace = new Workspace(join(workspaceRoot, "TASK-LIVE-002"));
      await mkdir(workspace.root, { recursive: true });

      const config = loadConfig({ cwd: PROJECT_ROOT });
      const provider = new RouterProvider({
        baseUrl: config.router.baseUrl,
        apiKey: config.router.apiKey,
        timeoutMs: config.router.timeoutMs,
        maxRetries: config.router.maxRetries,
      });

      const agent = new CoderAgent({
        provider,
        model: config.coder.model,
        workspace,
        logger: createLogger({ level: "info", format: "text" }),
        runner: new CommandRunner({ timeoutMs: 120_000 }),
        maxToolTurns: 14,
      });

      const output = (await agent.execute({
        task: LIVE_TASK,
        session: { task: LIVE_TASK } as any,
        workspacePath: workspace.root,
        cycle: 1,
        reason: "INITIAL",
      })) as CoderOutput;

      // The harness, not the model, produced these values.
      const written = await workspace.listFiles();
      console.log("\n--- live coder run ---");
      console.log("status:", output.status);
      console.log("files_written:", written.map((f) => f.path).join(", "));
      console.log("commands:", output.executed_commands?.map((c) => `${c.command} -> ${c.exitCode}`).join(" | "));
      console.log("tests_run:", output.tests_run.join(" | "), "tests_passed:", output.tests_passed);
      console.log("issues:", output.issues.join(" ; ") || "(none)");

      // REGRESSION GUARD (TASK-001): the coder must actually use its tools.
      // Before the fix, DeepSeek stopped after turn 1 with zero tool calls and
      // the run ended BLOCKED with an empty workspace.
      expect(
        written.length,
        "the coder wrote no files — it did not use its tools",
      ).toBeGreaterThan(0);
      expect(
        output.executed_commands?.length ?? 0,
        "the coder executed no command — no test was really run",
      ).toBeGreaterThan(0);
      expect(output.issues.join(" ")).not.toContain("no tool calls at all");
      expect(output.files_changed.length).toBeGreaterThan(0);
    },
    600_000,
  );
});

describeLive("live end-to-end orchestration (acceptance criteria)", () => {
  it(
    "TASK-001 -> Coder -> Reviewer -> APPROVED|REJECTED -> DONE|NEEDS_HUMAN with max 3 cycles",
    async () => {
      const runtime = await createRuntime({ cwd: PROJECT_ROOT, env: { ...process.env, RUN_LIVE: "1" } });
      const spec: TaskSpec = {
        ...LIVE_TASK,
        id: "TASK-001",
        workspaceSlug: "TASK-001",
      };

      const record = await runtime.orchestrator.run(spec);
      const report = renderRunReport(record, runtime.config.orchestrator.maxReviewCycles);
      console.log(`\n--- live orchestration report ---\n${report}`);

      // The acceptance criteria, asserted rather than assumed.
      expect(["DONE", "NEEDS_HUMAN"]).toContain(record.state);
      expect(record.reviewCycles).toBeLessThanOrEqual(3);
      expect(record.cycles.length).toBeGreaterThan(0);

      const verdicts = record.cycles
        .map((cycle) => cycle.reviewer?.verdict)
        .filter((verdict): verdict is "APPROVED" | "REJECTED" => Boolean(verdict));

      // Every state is reached through a real agent call.
      expect(record.history[0]).toBe("PENDING");
      expect(record.history).toContain("CODING");
      expect(record.history).toContain("TESTING");
      expect(record.history).toContain("REVIEW");

      if (record.state === "DONE") {
        expect(record.approved).toBe(true);
        expect(verdicts.at(-1)).toBe("APPROVED");
        expect(record.history).toContain("APPROVED");
      } else {
        expect(record.approved).toBe(false);
        expect(record.stopReason).toBeDefined();
      }

      // The reviewer really ran on the real router.
      expect(record.attempts.some((a) => a.kind === "REVIEWER" && a.ok)).toBe(true);
      expect(record.attempts.some((a) => a.kind === "CODER" && a.ok)).toBe(true);

      // REGRESSION GUARD (TASK-001): the coder must have performed real work.
      // The failing run produced three empty cycles with zero files and zero
      // commands, and the reviewer correctly rejected all of them.
      const firstCoder = record.cycles[0]?.coder;
      expect(firstCoder, "the first cycle has no coder output").toBeDefined();
      const coderDidWork =
        (firstCoder?.files_changed.length ?? 0) > 0 || (firstCoder?.executed_commands?.length ?? 0) > 0;
      expect(
        coderDidWork,
        `the coder performed no work in cycle 1 (files=${JSON.stringify(firstCoder?.files_changed)}, ` +
          `commands=${firstCoder?.executed_commands?.length ?? 0}, issues=${JSON.stringify(firstCoder?.issues)})`,
      ).toBe(true);

      await runtime.close();
    },
    900_000,
  );
});
