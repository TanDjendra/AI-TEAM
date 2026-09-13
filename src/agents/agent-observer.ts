/**
 * Agent instrumentation hook.
 *
 * The orchestrator passes an `AgentObserver` into the agent. The agent reports
 * what it is doing; the observer publishes typed events. The agent never touches
 * the bus, the database or a transport — which is what keeps the review loop and
 * the tool loop free of persistence concerns.
 *
 * Every method is optional so a caller can observe only what it needs, and every
 * call is fire-and-forget from the agent's perspective: `observed` returns a
 * promise the agent awaits so ordering is deterministic, but the orchestrator's
 * implementation never rejects.
 */

import type { ModelToolCall } from "../providers/model-provider.js";
import type { AgentRole } from "../events/types.js";
import type { ToolExecutionMeta } from "./tools.js";

export interface AgentObservationBase {
  agentId: string;
  role: AgentRole;
  taskId: string;
  cycle: number;
}

export interface AgentObserver {
  /** The agent began a run (one call to execute()). */
  onAgentStarted(
    info: AgentObservationBase & {
      model: string;
      attempt: number;
      runReason: "INITIAL" | "FIX";
    },
  ): Promise<void>;

  /** The agent finished a run, successfully or not. */
  onAgentFinished(
    info: AgentObservationBase & {
      ok: boolean;
      durationMs: number;
      resolvedModel?: string;
      promptTokens?: number;
      completionTokens?: number;
      cachedTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      latencyMs?: number;
      error?: string;
    },
  ): Promise<void>;

  /** The harness is about to execute a tool call. */
  onToolStarted(
    info: AgentObservationBase & {
      toolCallId: string;
      tool: string;
      arguments: Record<string, unknown>;
    },
  ): Promise<void>;

  /** The tool call returned (or failed). */
  onToolFinished(
    info: AgentObservationBase & {
      toolCallId: string;
      tool: string;
      success: boolean;
      durationMs: number;
      outputSummary: string;
      exitCode?: number | null;
    },
  ): Promise<void>;

  /** A file was written. `summary` is derived, never the file body. */
  onFileChanged(
    info: AgentObservationBase & {
      path: string;
      changeType: "created" | "modified" | "deleted";
      summary: string;
    },
  ): Promise<void>;

  /** A command was executed. `authoritative` marks the run that counts. */
  onTestFinished(
    info: AgentObservationBase & {
      command: string;
      exitCode: number | null;
      passed: boolean;
      timedOut: boolean;
      durationMs: number;
      outputSummary: string;
      authoritative: boolean;
    },
  ): Promise<void>;
}

/** A no-op observer: the default when persistence is not configured. */
export const nullAgentObserver: AgentObserver = {
  onAgentStarted: async () => {},
  onAgentFinished: async () => {},
  onToolStarted: async () => {},
  onToolFinished: async () => {},
  onFileChanged: async () => {},
  onTestFinished: async () => {},
};

/**
 * Builds a tool-call id that is stable and human-readable in the database.
 * Includes the turn so a dashboard can group calls by model turn.
 */
export function buildToolCallId(params: {
  taskId: string;
  cycle: number;
  turn: number;
  index: number;
  nativeId?: string;
}): string {
  const suffix = params.nativeId ? params.nativeId : `${params.turn}-${params.index}`;
  return `${params.taskId}:c${params.cycle}:${suffix}`;
}

/** Convenience for observers that need to describe a native call. */
export function describeToolCall(call: ModelToolCall): string {
  return `${call.name}(${Object.keys(call.args ?? {}).join(",")})`;
}

export type { ToolExecutionMeta };
