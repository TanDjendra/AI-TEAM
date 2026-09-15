/**
 * Agent profiles (Phase V2-02, extended in V2.1).
 *
 * A profile describes *how* a role behaves: which model it defaults to, the
 * system prompt template prepended to the role's built-in prompt, and which
 * tools it may use.
 *
 * V2.1 makes this dynamic: built-in roles (coder/reviewer/planner) stay as the
 * static defaults below, and the JSON config file may override them or introduce
 * brand-new roles (e.g. "frontend-coder"). The overlay is applied by
 * `resolveAgentProfiles`, never by mutating the static table.
 *
 * Runtime scope note: custom roles are stored and validated in V2.1 but are NOT
 * yet wired into the orchestrator's execution loop. That is a deliberate,
 * separate iteration — see the V2.1 mapping plan.
 */

import type { AgentProfile } from "../domain/types.js";
import type { ConfiguredRole } from "./config-file.js";

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

/** The three roles the orchestrator's built-in pipeline understands today. */
export const BUILT_IN_ROLES: readonly ("coder" | "reviewer" | "planner")[] = [
  "coder",
  "reviewer",
  "planner",
];

export type BuiltInRole = (typeof BUILT_IN_ROLES)[number];

export function isBuiltInRole(role: string): role is BuiltInRole {
  return (BUILT_IN_ROLES as readonly string[]).includes(role);
}

/**
 * Merges the static built-in profiles with overrides from the config file.
 *
 * Rules:
 *  - A config role whose name matches a built-in role OVERRIDES that role's
 *    fields (any field left out keeps its built-in default).
 *  - A config role with a new name is appended as a custom profile.
 *  - The returned list always contains the three built-ins first, in order.
 */
export function resolveAgentProfiles(
  configured: readonly ConfiguredRole[] = [],
): readonly AgentProfile[] {
  const overrides = new Map<string, ConfiguredRole>();
  for (const role of configured) overrides.set(role.role, role);

  const resolved: AgentProfile[] = AGENT_PROFILES.map((base) => {
    const override = overrides.get(base.role);
    if (!override) return base;
    overrides.delete(base.role);
    return mergeProfile(base, override);
  });

  for (const extra of overrides.values()) {
    resolved.push(mergeProfile(undefined, extra));
  }

  return resolved;
}

function mergeProfile(base: AgentProfile | undefined, override: ConfiguredRole): AgentProfile {
  return {
    role: override.role,
    defaultModelId: override.defaultModelId ?? base?.defaultModelId ?? "",
    systemPromptTemplate: override.systemPromptTemplate ?? base?.systemPromptTemplate ?? "",
    // An explicit empty array means "no tools", which must survive the merge.
    ...(override.allowedTools !== undefined
      ? { allowedTools: override.allowedTools }
      : base?.allowedTools !== undefined
        ? { allowedTools: base.allowedTools }
        : {}),
  };
}

/**
 * Looks a profile up by role.
 *
 * Unlike the V2.0 version this no longer throws for an unknown role: with
 * dynamic roles, "not found" is a legitimate answer the caller must handle (the
 * orchestrator only ever asks for the three built-ins, which always resolve).
 */
export function findAgentProfile(
  role: string,
  profiles: readonly AgentProfile[] = AGENT_PROFILES,
): AgentProfile | undefined {
  return profiles.find((profile) => profile.role === role);
}

/**
 * V2.0-compatible accessor for the built-in roles.
 *
 * Kept so existing call sites (planner-agent, env.ts) compile unchanged; it now
 * accepts an optional overlay so the resolved view can be threaded through.
 */
export function getAgentProfile(
  role: BuiltInRole,
  profiles: readonly AgentProfile[] = AGENT_PROFILES,
): AgentProfile {
  const profile = findAgentProfile(role, profiles);
  if (!profile) {
    throw new Error(`System invariant violation: no static profile defined for role '${role}'`);
  }
  return profile;
}
