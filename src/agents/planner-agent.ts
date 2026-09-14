import { getAgentProfile } from "../config/agent-profiles.js";
import { WorkflowPlanner } from "../orchestration/workflow-planner.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { WorkflowSpec, WorkspaceBinding } from "../domain/workflow.js";

export interface PlannerAgentOptions {
  modelProvider: ModelProvider;
  /** Optional override for the model ID. If omitted, uses the profile default. */
  modelId?: string;
  maxRetries?: number;
}

/**
 * The PlannerAgent operates at a meta-level, outside the standard TaskState loop.
 * It strictly enforces "no tools" and "no workspace" invariants, acting as a pure
 * logical planner that yields a validated WorkflowSpec.
 */
export class PlannerAgent {
  private planner: WorkflowPlanner;

  constructor(options: PlannerAgentOptions) {
    const profile = getAgentProfile("planner");
    
    // Enforce no-tools invariant
    if (profile.allowedTools && profile.allowedTools.length > 0) {
      throw new Error("System invariant violation: planner profile must not allow tools.");
    }

    const modelId = options.modelId || profile.defaultModelId;
    this.planner = new WorkflowPlanner({
      modelProvider: options.modelProvider,
      modelId,
      maxRetries: options.maxRetries,
    });
  }

  /**
   * Plans a workflow based on an objective.
   * Enforces no-workspace (does not operate inside a workspace, merely specifies the binding).
   */
  async plan(objective: string, workspaceBinding: WorkspaceBinding): Promise<WorkflowSpec> {
    return this.planner.plan(objective, workspaceBinding);
  }
}
