/**
 * Domain contracts for the Workflow / DAG subsystem (Phase V2-04).
 *
 * Layering rule (enforced by reviewing imports):
 *   domain/workflow.ts → depends on nothing else in the codebase.
 *
 * The V1 TaskState FSM is NOT modified. NodeStatus is a separate overlay
 * that lives at the workflow layer. The mapping is intentional:
 *   CLAIMED  → a V1 `tasks` row is materialised (FK set in workflow_nodes)
 *   RUNNING  → the V1 task is actively executing inside the Coder→Review loop
 *   SUCCEEDED → the V1 task reached DONE with approved = true
 *
 *
 * No scheduler, no planner model calls, no artifact payloads in this phase.
 */

import type { ArtifactReference } from "./artifact.js";

// ---------------------------------------------------------------------------
// Node lifecycle states (distinct from V1 TaskState — do not merge these)
// ---------------------------------------------------------------------------

export const NODE_STATUSES = [
  "WAITING_DEPENDENCIES", // ≥1 predecessor has not yet SUCCEEDED
  "READY",                // All predecessors SUCCEEDED; eligible for the scheduler
  "CLAIMED",              // A worker reserved this node; V1 tasks row materialised
  "RUNNING",              // Associated V1 task is actively executing
  "SUCCEEDED",            // V1 task reached DONE (approved = true)
  "BLOCKED",              // A predecessor was CANCELLED or BLOCKED (poison-pill)
  "CANCELLED",            // Explicitly cancelled before or during execution
] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

/** Terminal node states — no outgoing transitions possible. */
export const TERMINAL_NODE_STATUSES: readonly NodeStatus[] = [
  "SUCCEEDED",
  "BLOCKED",
  "CANCELLED",
];

export function isTerminalNodeStatus(s: NodeStatus): boolean {
  return TERMINAL_NODE_STATUSES.includes(s);
}

// ---------------------------------------------------------------------------
// Workflow-level status
// ---------------------------------------------------------------------------

export const WORKFLOW_STATUSES = [
  "DRAFT",      // Spec persisted, validation not yet run
  "VALIDATED",  // Passed WorkflowValidator; ready for the scheduler
  "RUNNING",    // ≥1 node is CLAIMED or RUNNING
  "SUCCEEDED",  // Every node reached SUCCEEDED
  "FAILED",     // ≥1 node is permanently BLOCKED
  "CANCELLED",  // Human-cancelled the whole workflow
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

// ---------------------------------------------------------------------------
// Spec — immutable declaration authored before execution
// ---------------------------------------------------------------------------

/**
 * The root declaration of a workflow. Immutable after VALIDATED.
 * This is the structure the caller submits; the repository wraps it in
 * WorkflowRecord to add a generated id and timestamps.
 */
export interface WorkflowSpec {
  /**
   * Human-readable top-level goal. Passed as context to every node's TaskSpec.
   * Required; must be a non-empty string.
   */
  readonly objective: string;

  /**
   * The single shared workspace that all nodes in this workflow operate on.
   * WorkflowValidator enforces exactly one write-resource per workflow.
   * Either `slug` or `path` must be provided (not both, not neither).
   */
  readonly workspaceBinding: WorkspaceBinding;

  /**
   * Ordered list of node declarations.
   * Must contain ≥ 1 node. All `key` values must be unique within the workflow.
   */
  readonly nodes: readonly WorkflowNodeDecl[];

  /**
   * Directed dependency edges.
   * A `from → to` edge means: node `from` MUST reach SUCCEEDED before node
   * `to` transitions from WAITING_DEPENDENCIES to READY.
   * Must form a strict DAG (no cycles, no self-edges).
   */
  readonly edges: readonly WorkflowEdgeDecl[];

  /**
   * Optional per-node profile overrides.
   * Keys are node keys that must exist in `nodes`.
   * Values reference model/agent profile IDs from the existing registries.
   * WorkflowValidator checks that referenced profile IDs exist.
   */
  readonly profileBindings?: Readonly<Record<string, WorkflowProfileRef>>;
}

/** Identifies the workspace all nodes in the workflow share. */
export interface WorkspaceBinding {
  /**
   * Matches V1's TaskSpec.workspaceSlug — the orchestrator seeds a new
   * directory under the workspace root with this slug.
   */
  readonly slug?: string;
  /**
   * Matches V1's TaskSpec.workspacePath — use an existing absolute path.
   */
  readonly path?: string;
}

/** Declaration of one node in the workflow spec. */
export interface WorkflowNodeDecl {
  /**
   * Short, URL-safe identifier unique within this workflow.
   * e.g. "scaffold", "test-suite", "deploy-staging"
   */
  readonly key: string;
  /** Human-readable label for dashboards and logs. */
  readonly title: string;
  /** Forwarded to the V1 TaskSpec when the node is CLAIMED. */
  readonly description?: string;
  /** Forwarded to the V1 TaskSpec as acceptanceCriteria when claimed. */
  readonly acceptanceCriteria?: readonly string[];
  /** Artifacts that this node consumes from upstream nodes. */
  readonly inputs?: readonly ArtifactReference[];
  /** Artifacts that this node produces for downstream nodes. */
  readonly outputs?: readonly ArtifactReference[];
}

/**
 * A single directed edge in the dependency graph.
 * Semantics: node `from` must reach SUCCEEDED before node `to` becomes READY.
 */
export interface WorkflowEdgeDecl {
  /** Key of the predecessor node. Must exist in WorkflowSpec.nodes. */
  readonly from: string;
  /** Key of the successor node. Must exist in WorkflowSpec.nodes. */
  readonly to: string;
}

/** Per-node override of model and agent profile references. */
export interface WorkflowProfileRef {
  /** Override the coder model for this node (must exist in the model profile registry). */
  readonly coderModelId?: string;
  /** Override the reviewer model for this node. */
  readonly reviewerModelId?: string;
  /** Override the agent profile (system prompt template etc.) for this node. */
  readonly agentProfileId?: string;
}

// ---------------------------------------------------------------------------
// Runtime records — persisted by the repositories
// ---------------------------------------------------------------------------

/**
 * The persisted envelope for a workflow.
 * Created by WorkflowRepository.create(); the `id` is generated there.
 */
export interface WorkflowRecord {
  readonly id: string;
  readonly spec: WorkflowSpec;
  readonly status: WorkflowStatus;
  readonly createdAt: string; // ISO 8601
  readonly updatedAt: string; // ISO 8601
}

/**
 * The persisted state of a single workflow node.
 * Created in bulk by WorkflowRepository when a workflow is persisted.
 */
export interface WorkflowNodeRecord {
  readonly id: string;
  readonly workflowId: string;
  /** Unique within the workflow — enforced by DB constraint. */
  readonly nodeKey: string;
  readonly title: string;
  readonly status: NodeStatus;
  /**
   * FK to tasks.id. NULL until the node is CLAIMED.
   * At most one live V1 task per node (enforced by the claim transition).
   */
  readonly currentTaskId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A single directed edge as persisted in workflow_dependencies.
 * One row per edge — never JSONB arrays.
 */
export interface WorkflowDependencyRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly fromNodeKey: string;
  readonly toNodeKey: string;
}

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

/**
 * CRUD for the `workflows` and `workflow_nodes` tables.
 * All writes go through this repository; callers never write raw SQL.
 */
export interface WorkflowRepository {
  /**
   * Persists a new workflow (status = DRAFT) and materialises all node rows.
   * The `id` is generated by the repository (UUID).
   */
  create(spec: WorkflowSpec): Promise<WorkflowRecord>;

  findById(id: string): Promise<WorkflowRecord | null>;

  updateStatus(id: string, status: WorkflowStatus): Promise<void>;

  /** Returns all nodes for a workflow, ordered by created_at. */
  findNodes(workflowId: string): Promise<WorkflowNodeRecord[]>;

  /**
   * Atomically updates a node's status.
   * Pass `taskId` only when transitioning to CLAIMED (materialises the FK).
   */
  updateNodeStatus(
    workflowId: string,
    nodeKey: string,
    status: NodeStatus,
    taskId?: string,
  ): Promise<void>;

  /** Returns all READY nodes for a workflow. Used by the future scheduler. */
  findReadyNodes(workflowId: string): Promise<WorkflowNodeRecord[]>;

  list(filter?: { status?: WorkflowStatus }): Promise<WorkflowRecord[]>;

  /**
   * Atomically claims the next READY node for the given workerId.
   */
  claimNextReady(
    workerId: string | undefined,
    taskRepo: import("../persistence/repositories/task-repository.js").TaskRepository,
  ): Promise<NodeClaimResult>;

  /**
   * Evaluates if all predecessors of a node are SUCCEEDED, and if so,
   * transitions the node to READY. Returns true if the node became READY.
   */
  evaluateAndTransitionNodeToReady(workflowId: string, nodeKey: string): Promise<boolean>;

  /**
   * Transitions a node to BLOCKED if it is currently in a state that can be
   * safely blocked (WAITING_DEPENDENCIES, READY, CLAIMED). Returns true if it was blocked.
   */
  transitionNodeToBlockedIfPending(workflowId: string, nodeKey: string): Promise<boolean>;
}

export interface NodeClaimResult {
  claimed: boolean;
  node?: WorkflowNodeRecord;
  taskId?: string;
  reason?: "no-ready-nodes" | "already-claimed" | "workflow-not-found" | "workflow-not-validated";
}

/**
 * CRUD for the normalized `workflow_dependencies` edge table.
 * Separate repository so it can be independently tested and injected.
 */
export interface WorkflowDependencyRepository {
  /**
   * Bulk-inserts all edges for a newly created workflow.
   * Idempotent via ON CONFLICT DO NOTHING.
   */
  createEdges(workflowId: string, edges: readonly WorkflowEdgeDecl[]): Promise<void>;

  /** Returns the keys of all nodes that must SUCCEED before `toNodeKey` becomes READY. */
  findPredecessors(workflowId: string, toNodeKey: string): Promise<string[]>;

  /** Returns the keys of all nodes that become eligible once `fromNodeKey` SUCCEEDS. */
  findSuccessors(workflowId: string, fromNodeKey: string): Promise<string[]>;

  /** Returns all edges for a workflow (used by the validator and scheduler). */
  findAll(workflowId: string): Promise<WorkflowDependencyRecord[]>;
}

/**
 * CRUD for the `workflow_artifacts` table.
 */
export interface WorkflowArtifactRepository {
  /**
   * Persists a newly produced artifact manifest.
   */
  create(manifest: Omit<import("./artifact.js").ArtifactManifest, "id" | "createdAt">): Promise<import("./artifact.js").ArtifactManifest>;

  /** Returns all artifacts produced by a specific node in a workflow. */
  findByProducer(workflowId: string, producerNodeKey: string): Promise<import("./artifact.js").ArtifactManifest[]>;

  /** Returns a specific artifact by workflow, producer, and name. */
  findByName(workflowId: string, producerNodeKey: string, name: string): Promise<import("./artifact.js").ArtifactManifest | null>;
  
  /** Returns all artifacts for a workflow. */
  findAll(workflowId: string): Promise<import("./artifact.js").ArtifactManifest[]>;
}
