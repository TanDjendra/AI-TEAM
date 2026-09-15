import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppConfig } from "../../src/config/env.js";
import { getAgentProfile } from "../../src/config/agent-profiles.js";
import { getModelProfile, synthesizeModelProfile } from "../../src/config/model-profiles.js";
import type {
  Agent,
  AgentInput,
  AgentOutput,
  CoderOutput,
  CommandRunEvidence,
  ReviewerOutput,
} from "../../src/domain/types.js";

export async function makeTempDir(prefix = "ai-team-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupDir(path: string): Promise<void> {
  // On Windows a just-killed child can still hold a handle for a moment.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

export function testConfig(overrides: {
  workspaceRoot: string;
  maxReviewCycles?: number;
  maxAgentAttempts?: number;
  /** PHASE 6: stale-run threshold for recovery tests. */
  staleRunThresholdMs?: number;
  heartbeatIntervalMs?: number;
  /** When set, the persistence tests point at their ephemeral Postgres. */
  databaseUrl?: string;
  migrationsDir?: string;
  requirePersistence?: boolean;
}): AppConfig {
  return {
    router: {
      baseUrl: "http://localhost:20128/v1",
      apiKey: "test-key",
      apiKeySource: "env",
      timeoutMs: 5_000,
      maxRetries: 0,
      verifyOnStart: false,
    },
    coder: {
      model: "grip/deepseek-v4.1-flash",
      agentProfile: getAgentProfile("coder"),
      modelProfile: getModelProfile("grip/deepseek-v4.1-flash") ?? synthesizeModelProfile("grip/deepseek-v4.1-flash", 128_000),
    },
    reviewer: {
      model: "grip/gpt-5.6-luna",
      agentProfile: getAgentProfile("reviewer"),
      modelProfile: getModelProfile("grip/gpt-5.6-luna") ?? synthesizeModelProfile("grip/gpt-5.6-luna", 128_000),
    },
    planner: {
      model: "grip/gpt-5.6-luna",
    },
    orchestrator: {
      maxReviewCycles: overrides.maxReviewCycles ?? 3,
      maxAgentAttempts: overrides.maxAgentAttempts ?? 2,
      workspaceRoot: overrides.workspaceRoot,
      staleRunThresholdMs: overrides.staleRunThresholdMs ?? 120_000,
      heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 5_000,
      staleSweepIntervalMs: 60_000,
      contextCompactionEnabled: false,
      contextCompactionRatio: 0.75,
      modelContextWindow: 128000,
      workflowEnabled: false,
      gitWorkspaceEnabled: false,
      workerPoolSize: 4,
    },
    logging: { level: "error", format: "json" },
    database: {
      ...(overrides.databaseUrl ? { url: overrides.databaseUrl } : {}),
      ssl: false,
      maxConnections: 5,
      migrationsDir: overrides.migrationsDir ?? "",
      requirePersistence: overrides.requirePersistence ?? true,
    },
    configFilePath: "",
    configFile: { version: 1, models: {}, catalog: [], roles: [] },
  };
}

export function executedCommand(
  command: string,
  exitCode: number | null,
  output = "",
): CommandRunEvidence {
  return { command, exitCode, timedOut: false, output };
}

export function makeCoderOutput(overrides: Partial<CoderOutput> = {}): CoderOutput {
  return {
    agentId: "fake-coder",
    role: "coder",
    ok: true,
    contractParsed: true,
    status: "DONE",
    summary: "implemented the task",
    files_changed: ["src/index.js"],
    tests_run: ["node --test"],
    tests_passed: true,
    issues: [],
    notes: "",
    executed_commands: [executedCommand("node --test", 0, "# pass 4")],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    resolvedModel: "deepseek-v4.1-flash",
    ...overrides,
  };
}

export function makeReviewerOutput(overrides: Partial<ReviewerOutput> = {}): ReviewerOutput {
  return {
    agentId: "fake-reviewer",
    role: "reviewer",
    ok: true,
    contractParsed: true,
    verdict: "APPROVED",
    summary: "looks correct",
    issues: [],
    required_fixes: [],
    severity: "NONE",
    usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
    resolvedModel: "gpt-5.6-luna",
    ...overrides,
  };
}

/** A scripted agent: returns the i-th queued output for the i-th call. */
export class ScriptedAgent implements Agent {
  readonly calls: AgentInput[] = [];

  constructor(
    readonly id: string,
    readonly role: string,
    private readonly outputs: AgentOutput[],
    private readonly fallback?: AgentOutput,
  ) {}

  async execute(input: AgentInput): Promise<AgentOutput> {
    this.calls.push(input);
    const index = this.calls.length - 1;
    const output = this.outputs[index] ?? this.fallback ?? this.outputs[this.outputs.length - 1];
    if (!output) throw new Error(`ScriptedAgent(${this.id}) has no output for call ${index + 1}`);
    return output;
  }
}
