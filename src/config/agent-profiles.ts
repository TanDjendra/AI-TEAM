import type { AgentProfile } from "../domain/types.js";

export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    role: "coder",
    defaultModelId: "grip/deepseek-v4.1-flash",
    systemPromptTemplate: "You are an expert software engineer. Follow the user's instructions exactly.",
    allowedTools: ["read_file", "write_file", "list_files", "run_command", "search_files"],
  },
  {
    role: "reviewer",
    defaultModelId: "grip/gpt-5.6-luna",
    systemPromptTemplate: "You are an expert code reviewer. Assess whether the provided evidence proves the task is complete and correct.",
    allowedTools: [], // Reviewer is strictly isolated and uses evidence
  },
  {
    role: "planner",
    defaultModelId: "grip/gpt-5.6-luna",
    systemPromptTemplate: "You are an expert AI orchestrator. Decompose objectives into valid workflow graphs.",
    allowedTools: [], // Planner operates on pure logic/schema, no tools
  },
];

export function getAgentProfile(role: "coder" | "reviewer" | "planner"): AgentProfile {
  const profile = AGENT_PROFILES.find((p) => p.role === role);
  if (!profile) {
    throw new Error(`System invariant violation: no static profile defined for role '${role}'`);
  }
  return profile;
}

