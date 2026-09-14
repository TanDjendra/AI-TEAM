import type { ModelProvider, ModelMessage } from "../providers/model-provider.js";
import type { WorkflowSpec, WorkspaceBinding } from "../domain/workflow.js";
import { WorkflowValidator } from "./workflow-validator.js";
import { LLMGeneratedWorkflowSchema } from "./workflow-planner.schema.js";

export class PlannerError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PlannerError";
  }
}

export interface WorkflowPlannerOptions {
  modelProvider: ModelProvider;
  modelId: string;
  maxRetries?: number;
}

export class WorkflowPlanner {
  private provider: ModelProvider;
  private modelId: string;
  private maxRetries: number;
  private validator: WorkflowValidator;

  constructor(options: WorkflowPlannerOptions) {
    this.provider = options.modelProvider;
    this.modelId = options.modelId;
    this.maxRetries = options.maxRetries ?? 3;
    this.validator = new WorkflowValidator();
  }

  async plan(objective: string, workspaceBinding: WorkspaceBinding): Promise<WorkflowSpec> {
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: `You are an expert AI orchestrator. Your job is to break down a user's objective into a valid Directed Acyclic Graph (DAG) of workflow nodes.
You must output ONLY valid JSON matching this schema:
{
  "rationale": "string (Explanation for the proposed workflow)",
  "nodes": [
    {
      "key": "string (URL-safe)",
      "title": "string",
      "description": "string (optional)",
      "acceptanceCriteria": ["string"]
    }
  ],
  "edges": [
    {
      "from": "string (node key)",
      "to": "string (node key)"
    }
  ]
}
Ensure the graph has no cycles and no self-edges. All edge endpoints must exist in the nodes list.`,
      },
      {
        role: "user",
        content: `Objective: ${objective}`,
      },
    ];

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const response = await this.provider.chat({
        model: this.modelId,
        messages,
        json: true,
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.content);
      } catch (err) {
        lastError = new PlannerError("Failed to parse LLM response as JSON", err);
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content: "Your previous response was not valid JSON. Please return ONLY a valid JSON object.",
        });
        continue;
      }

      const schemaResult = LLMGeneratedWorkflowSchema.safeParse(parsed);
      if (!schemaResult.success) {
        lastError = new PlannerError("LLM response did not match the expected schema", schemaResult.error);
        messages.push({ role: "assistant", content: response.content });
        const issues = schemaResult.error.issues.map(i => `- ${i.path.join(".")}: ${i.message}`).join("\n");
        messages.push({
          role: "user",
          content: `Your previous response did not match the required schema. Fix the following validation errors:\n${issues}`,
        });
        continue;
      }

      const generated = schemaResult.data;
      
      const spec: WorkflowSpec = {
        objective,
        workspaceBinding,
        nodes: generated.nodes,
        edges: generated.edges ?? [],
      };

      const validationResult = this.validator.validate(spec);
      if (validationResult.valid) {
        return spec;
      }

      lastError = new PlannerError("Generated workflow failed validation");
      messages.push({ role: "assistant", content: response.content });
      
      const errorList = validationResult.errors.map(e => `- [${e.code}] ${e.message}`).join("\n");
      messages.push({
        role: "user",
        content: `Your previous workflow graph was invalid. Please fix the following errors:\n${errorList}\n\nEnsure the graph is a strict Directed Acyclic Graph (DAG) and all edge endpoints exist.`,
      });
    }

    throw new PlannerError(`Failed to generate a valid workflow after ${this.maxRetries} retries`, lastError);
  }
}
