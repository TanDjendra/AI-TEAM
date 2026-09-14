import { z } from "zod";

export const ArtifactReferenceSchema = z.object({
  name: z.string(),
  producerNodeKey: z.string().optional(),
});

export const WorkflowNodeDeclSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9-]+$/).describe("Short, URL-safe identifier unique within this workflow."),
  title: z.string().describe("Human-readable label for dashboards and logs."),
  description: z.string().optional().describe("Forwarded to the V1 TaskSpec when the node is CLAIMED."),
  acceptanceCriteria: z.array(z.string()).optional().describe("List of criteria for node completion."),
  inputs: z.array(ArtifactReferenceSchema).optional(),
  outputs: z.array(ArtifactReferenceSchema).optional(),
});

export const WorkflowEdgeDeclSchema = z.object({
  from: z.string().describe("Key of the predecessor node."),
  to: z.string().describe("Key of the successor node.")
});

export const LLMGeneratedWorkflowSchema = z.object({
  rationale: z.string().describe("Explanation for the proposed workflow"),
  nodes: z.array(WorkflowNodeDeclSchema).min(1),
  edges: z.array(WorkflowEdgeDeclSchema).optional()
});

export type LLMGeneratedWorkflow = z.infer<typeof LLMGeneratedWorkflowSchema>;
