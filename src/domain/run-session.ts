import type { TaskSpec } from "./types.js";

/** Kontrol interupsi kooperatif yang diteruskan secara eksplisit (immutable per run). */
export interface RunControl {
  /**
   * Called before an agent call, before a tool execution, and before each review pass.
   * Returning a request unwinds the run at that point.
   */
  readonly checkInterrupt?: () => { intent: "pause" | "cancel"; reason: string; actor?: string } | undefined;
  /**
   * Cancels an in-flight model/tool call. When present, an interrupt can stop a
   * slow request instead of waiting for it to finish.
   */
  readonly interruptSignal?: AbortSignal;
}

/** State dari satu sesi eksekusi yang unik dan immutable, menggantikan field class di Runner/Hooks. */
export interface RunSession {
  readonly taskRunId: string;
  readonly taskId: string;
  readonly task: TaskSpec;
  readonly control: RunControl;
  readonly agentKeys: { coder: string; reviewer: string };
  readonly agentIds: { coder?: string; reviewer?: string };
}
