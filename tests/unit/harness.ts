import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { AppConfig } from "../../src/config/env.js";
import { silentLogger } from "../../src/domain/logger.js";
import type { AgentOutput, CoderOutput, ReviewerOutput, TaskSpec } from "../../src/domain/types.js";
import type {
  ChatStreamChunk,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ProviderHealth,
} from "../../src/providers/model-provider.js";
import { OrchestratorService } from "../../src/orchestration/runner.js";
import { DirectoryWorkspaceResolver } from "../../src/infrastructure/workspace-resolver.js";
import { cleanupDir, makeTempDir, ScriptedAgent, testConfig } from "../helpers/index.js";

/**
 * Drives the real OrchestratorService with scripted agents.
 *
 * Only the two agents and the transport are substituted. The state machine, the
 * review loop, the budget policy, the bookkeeping and the report are the real
 * implementations.
 */

export interface RunHarnessOptions {
  coderOutputs: AgentOutput[];
  reviewerOutputs: AgentOutput[];
  maxReviewCycles?: number;
  maxAgentAttempts?: number;
  spec?: TaskSpec;
  /** Skip in-process workspace preparation (the scripted agents do not write). */
  prepareWorkspace?: boolean;
}

export interface RunHarnessResult {
  record: Awaited<ReturnType<OrchestratorService["run"]>>;
  config: AppConfig;
  coderAgent: ScriptedAgent;
  reviewerAgent: ScriptedAgent;
  cleanup(): Promise<void>;
}

/** A provider that is never used: scripted agents bypass it entirely. */
export class UnusedProvider implements ModelProvider {
  readonly id = "unused";
  readonly baseUrl = "http://unused.invalid/v1";

  async chat(_input: ModelRequest): Promise<ModelResponse> {
    throw new Error("UnusedProvider.chat must never be called in these tests");
  }

  // eslint-disable-next-line require-yield
  async *chatStream(_input: ModelRequest): AsyncGenerator<ChatStreamChunk, ModelResponse, void> {
    throw new Error("UnusedProvider.chatStream must never be called in these tests");
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async health(): Promise<ProviderHealth> {
    return { ok: false, baseUrl: this.baseUrl, latencyMs: 0, error: "unused" };
  }
}

export const DEFAULT_TEST_SPEC: TaskSpec = {
  id: "TASK-001",
  title: "Test task",
  description: "A task used by the orchestrator tests.",
  acceptanceCriteria: ["the tests pass"],
};

export async function runOrchestrator(options: RunHarnessOptions): Promise<RunHarnessResult> {
  const workspaceRoot = await makeTempDir();
  const config = testConfig({
    workspaceRoot,
    ...(options.maxReviewCycles === undefined ? {} : { maxReviewCycles: options.maxReviewCycles }),
    ...(options.maxAgentAttempts === undefined ? {} : { maxAgentAttempts: options.maxAgentAttempts }),
  });

  const spec = options.spec ?? DEFAULT_TEST_SPEC;

  const coderAgent = new ScriptedAgent(
    "coder-agent",
    "coder",
    options.coderOutputs,
    options.coderOutputs[options.coderOutputs.length - 1],
  );
  const reviewerAgent = new ScriptedAgent(
    "reviewer-agent",
    "reviewer",
    options.reviewerOutputs,
    options.reviewerOutputs[options.reviewerOutputs.length - 1],
  );

  const orchestrator = new OrchestratorService({
    provider: new UnusedProvider(),
    config,
    logger: silentLogger(),
    createCoder: () => coderAgent,
    createReviewer: () => reviewerAgent,
    workspaceResolver:
      options.prepareWorkspace === false
        ? { resolve: async () => join(workspaceRoot, spec.workspaceSlug ?? spec.id), cleanup: async () => {} }
        : {
            resolve: async (task) => {
              const resolver = new DirectoryWorkspaceResolver(workspaceRoot, silentLogger());
              const dir = await resolver.resolve(task);
              await mkdir(join(dir, "src"), { recursive: true });
              return dir;
            },
            cleanup: async () => {}
          },
  });

  const record = await orchestrator.run(spec);

  return {
    record,
    config,
    coderAgent,
    reviewerAgent,
    cleanup: () => cleanupDir(workspaceRoot),
  };
}

/** Convenience alias used by a couple of tests. */
export function isCoder(output: AgentOutput): output is CoderOutput {
  return output.role === "coder";
}

export function isReviewer(output: AgentOutput): output is ReviewerOutput {
  return output.role === "reviewer";
}
