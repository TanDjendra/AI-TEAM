/**
 * Core domain contracts for the AI Team Orchestrator.
 *
 * Layering rule (enforced by reviewing imports):
 *   domain/  -> depends on nothing
 *   agents/  -> depends on domain + providers (interfaces only)
 *   providers/ -> depends on domain
 *   orchestration/ -> depends on domain + agents (interfaces only)
 *
 * The Coder is a *tool-using* agent (it reads/writes files and runs tests through
 * the workspace), while the Reviewer is a *pure text* agent with no filesystem
 * access. That difference is modelled explicitly so the orchestrator never has to
 * special-case a role by string comparison.
 */

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

export const TASK_STATES = [
  "PENDING",
  "CODING",
  "TESTING",
  "REVIEW",
  "REJECTED",
  "FIXING",
  "APPROVED",
  "DONE",
  "NEEDS_HUMAN",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** Terminal states end the pipeline. Everything else must have an outgoing edge. */
export const TERMINAL_STATES: readonly TaskState[] = ["DONE", "NEEDS_HUMAN"];

/** A stopping decision produced by the orchestrator's policy layer. */
export type StopReason =
  | "MAX_REVIEW_CYCLES"
  | "REVIEWER_UNAVAILABLE"
  | "CODER_UNAVAILABLE"
  | "TESTS_FAILED_AFTER_FIX"
  | "INVALID_AGENT_OUTPUT"
  | "BUDGET_EXCEEDED";

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export interface TaskSpec {
  /** e.g. "TASK-001" */
  id: string;
  title: string;
  description: string;
  /** Optional free-form acceptance criteria handed to both agents. */
  acceptanceCriteria?: string[];
  /**
   * When set, the orchestrator seeds a brand-new workspace under the workspace
   * root with this slug (e.g. "TASK-001") instead of running in `repoPath`.
   */
  workspaceSlug?: string;
}

export type AttemptKind = "CODER" | "REVIEWER";

/** One recorded agent call. Append-only audit trail. */
export interface AgentAttempt {
  attempt: number;
  kind: AttemptKind;
  /** Review cycle number the attempt belongs to (1-based). */
  cycle: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  /** Verified usage reported by the provider, when available. */
  usage?: TokenUsage;
  /** Model actually resolved by the router (may differ from the requested id). */
  resolvedModel?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // Phase 7C Observability
  cachedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TaskRecord {
  id: string;
  spec: TaskSpec;
  state: TaskState;
  /** Number of REVIEW transitions performed (1-based once the first review runs). */
  reviewCycles: number;
  approved: boolean;
  stopReason?: StopReason;
  history: TaskState[];
  attempts: AgentAttempt[];
  /** Per-cycle coder/reviewer contracts, in order. */
  cycles: CycleRecord[];
  /** Absolute path of the sandbox the agents operate on. */
  workspacePath: string;
  startedAt: string;
  finishedAt?: string;
  notes: string[];
}

export interface CycleRecord {
  cycle: number;
  coder?: CoderOutput;
  reviewer?: ReviewerOutput;
  /** The orchestrator's own fail-safe reading of the verified command log. */
  testing?: TestAssessment;
}

/** Independent assessment made by the orchestrator in the TESTING state. */
export interface TestAssessment {
  /** True only when at least one test-class command actually ran. */
  testsExecuted: boolean;
  /** True only when every recorded command exited 0 and none timed out. */
  allCommandsPassed: boolean;
  commandCount: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Agent contracts
// ---------------------------------------------------------------------------

export interface Agent {
  readonly id: string;
  readonly role: string;
  execute(input: AgentInput): Promise<AgentOutput>;
}

/**
 * Everything an agent needs to run. The orchestrator owns this object; agents
 * never read process.env or global state for routing decisions.
 */
export interface AgentInput {
  task: TaskSpec;
  /** Absolute sandbox path. Read-only for the reviewer. */
  workspacePath: string;
  /** Absolute path of the agent's own scratch/log directory. */
  logDir?: string;
  /** 1-based review cycle this call belongs to. */
  cycle: number;
  /** Verbatim reviewer feedback, only present for fix runs. */
  previousReview?: ReviewerOutput;
  /** The coder contract produced in this cycle (reviewer input). */
  previousCoder?: CoderOutput;
  /** Harness-verified command executions from the coder run in this cycle. */
  previousExecutions?: readonly CommandRunEvidence[];
  /** 1-based coder attempt number inside the cycle. */
  attempt?: number;
  /** Human-readable reason the agent was invoked (e.g. "INITIAL" | "FIX"). */
  reason: AgentRunReason;
  /**
   * Cooperative-stop check (PHASE 6).
   *
   * Called before each model turn and before each tool execution. Throwing here
   * is how a human pause/cancel stops the agent at a safe point instead of
   * letting it issue more tool calls. Absent in normal operation.
   */
  guard?: () => void;
}

/** A command the harness really executed, with its real exit code. */
export interface CommandRunEvidence {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export type AgentRunReason = "INITIAL" | "FIX";

export interface AgentOutput {
  agentId: string;
  role: string;
  ok: boolean;
  /**
   * False when the model failed to emit a parsable contract object. The
   * orchestrator uses this to distinguish an infrastructure/format failure
   * (worth retrying) from a legitimate negative result such as a REJECTED
   * review or a coder that reports failing tests.
   */
  contractParsed?: boolean;
  reasoning?: string;
  error?: string;
  usage?: TokenUsage;
  resolvedModel?: string;
  /** Raw model text, kept for auditing/debugging. */
  raw?: string;
}

// ---------------------------------------------------------------------------
// Agent I/O contracts (required by the spec)
// ---------------------------------------------------------------------------

export type CoderStatus = "DONE" | "BLOCKED";

/** Contract the Coder must return after doing the work. */
export interface CoderOutput extends AgentOutput {
  role: "coder";
  status: CoderStatus;
  summary: string;
  files_changed: string[];
  tests_run: string[];
  tests_passed: boolean;
  issues: string[];
  notes: string;
  /**
   * Added by the harness (never by the model): the commands that were really
   * executed with their real exit codes. This is what the reviewer verifies.
   */
  executed_commands?: CommandRunEvidence[];
}

export type ReviewVerdict = "APPROVED" | "REJECTED";
export type ReviewSeverity = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Contract the Reviewer must return after inspecting the work. */
export interface ReviewerOutput extends AgentOutput {
  role: "reviewer";
  verdict: ReviewVerdict;
  summary: string;
  issues: string[];
  required_fixes: string[];
  severity: ReviewSeverity;
}

/** Runtime guard so the orchestrator can trust `result.output` without casting. */
export function isCoderOutput(value: AgentOutput): value is CoderOutput {
  const v = value as Partial<CoderOutput>;
  return (
    v.role === "coder" &&
    Array.isArray(v.files_changed) &&
    Array.isArray(v.tests_run) &&
    Array.isArray(v.issues) &&
    typeof v.tests_passed === "boolean" &&
    typeof v.summary === "string"
  );
}

export function isReviewerOutput(value: AgentOutput): value is ReviewerOutput {
  const v = value as Partial<ReviewerOutput>;
  return (
    v.role === "reviewer" &&
    (v.verdict === "APPROVED" || v.verdict === "REJECTED") &&
    Array.isArray(v.issues) &&
    Array.isArray(v.required_fixes) &&
    typeof v.summary === "string"
  );
}

export interface AgentResult<T extends AgentOutput = AgentOutput> {
  output: T;
  attempts: AgentAttempt[];
}
