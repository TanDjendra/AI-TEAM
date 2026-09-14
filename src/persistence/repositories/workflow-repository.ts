/**
 * PostgresWorkflowRepository — CRUD for `workflows` and `workflow_nodes` tables.
 *
 * All writes run inside a transaction to guarantee that a workflow row and
 * its node rows are always created atomically. A workflow without its nodes
 * is an invalid state that must never exist.
 *
 * Node keys are unique per workflow — this is enforced by the DB constraint
 * `uq_workflow_node_key (workflow_id, node_key)` and mirrored in the domain
 * validator, so a constraint violation here always indicates a programming
 * error in the caller, never a race condition.
 */

import { randomUUID } from "node:crypto";
import type { Db, UnitOfWork } from "../db.js";
import { Repository, withDbRetry } from "../db.js";
import { asIso, asNullableString, asString, requireRow, type Row } from "../rows.js";
import type {
  NodeStatus,
  WorkflowNodeRecord,
  WorkflowRecord,
  WorkflowRepository,
  WorkflowSpec,
  WorkflowStatus,
} from "../../domain/workflow.js";

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapWorkflowRow(row: Row): WorkflowRecord {
  return {
    id: asString(row.id),
    spec: (typeof row.spec === "string" ? JSON.parse(row.spec) : row.spec) as WorkflowSpec,
    status: asString(row.status) as WorkflowStatus,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapNodeRow(row: Row): WorkflowNodeRecord {
  return {
    id: asString(row.id),
    workflowId: asString(row.workflow_id),
    nodeKey: asString(row.node_key),
    title: asString(row.title),
    status: asString(row.status) as NodeStatus,
    currentTaskId: asNullableString(row.current_task_id) ?? null,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Repository implementation
// ---------------------------------------------------------------------------

export class PostgresWorkflowRepository extends Repository implements WorkflowRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  /**
   * Atomically creates the workflow record and all its node rows.
   * Status is always DRAFT on creation; call updateStatus() after validation.
   */
  async create(spec: WorkflowSpec): Promise<WorkflowRecord> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        const workflowId = randomUUID();
        const now = new Date().toISOString();

        // Insert workflow row.
        const wRows = await tx.query<Row>(
          `INSERT INTO workflows (id, spec, status, created_at, updated_at)
           VALUES ($1, $2::jsonb, 'DRAFT', $3, $3)
           RETURNING *`,
          [workflowId, JSON.stringify(spec), now],
        );
        const workflow = mapWorkflowRow(requireRow(wRows, "workflow.create"));

        // Insert all node rows in a single batch.
        for (const node of spec.nodes) {
          const nodeId = randomUUID();
          await tx.query(
            `INSERT INTO workflow_nodes
               (id, workflow_id, node_key, title, status, current_task_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'WAITING_DEPENDENCIES', NULL, $5, $5)`,
            [nodeId, workflowId, node.key, node.title, now],
          );
        }

        return workflow;
      }),
    );
  }

  async findById(id: string): Promise<WorkflowRecord | null> {
    const rows = await this.tx().query<Row>(
      `SELECT * FROM workflows WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? mapWorkflowRow(rows[0]!) : null;
  }

  async updateStatus(id: string, status: WorkflowStatus): Promise<void> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        await tx.query(
          `UPDATE workflows SET status = $2, updated_at = now() WHERE id = $1`,
          [id, status],
        );
      }),
    );
  }

  async findNodes(workflowId: string): Promise<WorkflowNodeRecord[]> {
    const rows = await this.tx().query<Row>(
      `SELECT * FROM workflow_nodes WHERE workflow_id = $1 ORDER BY created_at`,
      [workflowId],
    );
    return rows.map(mapNodeRow);
  }

  /**
   * Atomically updates a node's status.
   *
   * When `taskId` is provided (CLAIMED transition), the FK to `tasks.id` is
   * set at the same time. Passing `taskId` for any other transition is a
   * no-op for the FK column (it stays NULL or keeps its existing value).
   */
  async updateNodeStatus(
    workflowId: string,
    nodeKey: string,
    status: NodeStatus,
    taskId?: string,
  ): Promise<void> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        if (taskId !== undefined) {
          await tx.query(
            `UPDATE workflow_nodes
             SET status = $3, current_task_id = $4, updated_at = now()
             WHERE workflow_id = $1 AND node_key = $2`,
            [workflowId, nodeKey, status, taskId],
          );
        } else {
          await tx.query(
            `UPDATE workflow_nodes
             SET status = $3, updated_at = now()
             WHERE workflow_id = $1 AND node_key = $2`,
            [workflowId, nodeKey, status],
          );
        }
      }),
    );
  }

  async findReadyNodes(workflowId: string): Promise<WorkflowNodeRecord[]> {
    const rows = await this.tx().query<Row>(
      `SELECT * FROM workflow_nodes
       WHERE workflow_id = $1 AND status = 'READY'
       ORDER BY created_at`,
      [workflowId],
    );
    return rows.map(mapNodeRow);
  }

  async list(filter?: { status?: WorkflowStatus }): Promise<WorkflowRecord[]> {
    if (filter?.status) {
      const rows = await this.tx().query<Row>(
        `SELECT * FROM workflows WHERE status = $1 ORDER BY created_at DESC`,
        [filter.status],
      );
      return rows.map(mapWorkflowRow);
    }
    const rows = await this.tx().query<Row>(
      `SELECT * FROM workflows ORDER BY created_at DESC`,
    );
    return rows.map(mapWorkflowRow);
  }

  async claimNextReady(
    workerId: string | undefined,
    taskRepo: import("../../persistence/repositories/task-repository.js").TaskRepository,
  ): Promise<import("../../domain/workflow.js").NodeClaimResult> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        // SELECT the next READY node deterministically, locking it to prevent concurrent claims.
        // Orders by fewest dependencies (leaf nodes first), then creation time, then node_key.
        const rows = await tx.query<Row>(
          `SELECT wn.*, w.status as workflow_status
           FROM workflow_nodes wn
           JOIN workflows w ON wn.workflow_id = w.id
           WHERE wn.status = 'READY'
           ORDER BY
             (SELECT COUNT(*) FROM workflow_dependencies wd WHERE wd.from_node_key = wn.node_key) ASC,
             wn.created_at ASC,
             wn.node_key ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`
        );

        if (rows.length === 0) {
          return { claimed: false, reason: "no-ready-nodes" };
        }

        const nodeRow = rows[0]!;
        if (asString(nodeRow.workflow_status) !== "RUNNING" && asString(nodeRow.workflow_status) !== "VALIDATED") {
          return { claimed: false, reason: "workflow-not-validated" };
        }

        const wfRows = await tx.query<Row>("SELECT * FROM workflows WHERE id = $1", [asString(nodeRow.workflow_id)]);
        if (wfRows.length === 0) {
          return { claimed: false, reason: "workflow-not-found" };
        }
        const workflow = mapWorkflowRow(wfRows[0]!);

        const node = mapNodeRow(nodeRow);

        // Transition node to CLAIMED.
        await tx.query(
          `UPDATE workflow_nodes
           SET status = 'CLAIMED', updated_at = now()
           WHERE id = $1`,
          [node.id],
        );

        // Materialize the V1 task row inside the SAME transaction to avoid connection pool deadlocks.
        const taskRows = await tx.query(
          `WITH next_id AS (
            SELECT 'TASK-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(external_id, '^TASK-0*', ''), '')::integer), 0) + 1)::text, 3, '0') AS val
            FROM tasks
            WHERE external_id ~ '^TASK-\\d+$'
          )
          INSERT INTO tasks (external_id, title, description, workspace, max_review_cycles, status, assigned_agent_id, created_at)
          SELECT next_id.val, $1, $2, $3, $4, 'PENDING', $5, now()
          FROM next_id
          RETURNING id, external_id`,
          [
            node.title,
            workflow.spec.nodes.find((n) => n.key === node.nodeKey)?.description ?? workflow.spec.objective,
            workflow.spec.workspaceBinding.path ?? workflow.spec.workspaceBinding.slug!,
            3, // V1 default
            workerId ?? null
          ]
        );
        const taskId = asString(taskRows[0]!.id);
        const taskExternalId = asString(taskRows[0]!.external_id);

        // Set the FK on the node.
        await tx.query(
          `UPDATE workflow_nodes
           SET current_task_id = $2, updated_at = now()
           WHERE id = $1`,
          [node.id, taskId],
        );

        // Ensure workflow status is RUNNING.
        if (workflow.status !== "RUNNING") {
          await tx.query(
            `UPDATE workflows SET status = 'RUNNING', updated_at = now() WHERE id = $1`,
            [workflow.id],
          );
        }

        return {
          claimed: true,
          node: { ...node, status: "CLAIMED", currentTaskId: taskId },
          taskId: taskExternalId, // returning the external id as it is what SingleProcessWorker.start expects
        };
      }),
    );
  }

  async evaluateAndTransitionNodeToReady(workflowId: string, nodeKey: string): Promise<boolean> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        // Use an advisory lock on the node to prevent concurrent evaluation
        await tx.advisoryLock(`workflow-node:${workflowId}:${nodeKey}`);
        
        const nodeRows = await tx.query<Row>(
          `SELECT status FROM workflow_nodes WHERE workflow_id = $1 AND node_key = $2`,
          [workflowId, nodeKey]
        );
        if (nodeRows.length === 0 || asString(nodeRows[0]!.status) !== "WAITING_DEPENDENCIES") {
          return false;
        }

        // Check if all predecessors are SUCCEEDED
        const predRows = await tx.query<Row>(
          `SELECT wn.status 
           FROM workflow_dependencies wd
           JOIN workflow_nodes wn ON wd.workflow_id = wn.workflow_id AND wd.from_node_key = wn.node_key
           WHERE wd.workflow_id = $1 AND wd.to_node_key = $2`,
          [workflowId, nodeKey]
        );

        const allSucceeded = predRows.every(r => asString(r.status) === "SUCCEEDED");
        
        if (allSucceeded) {
          await tx.query(
            `UPDATE workflow_nodes SET status = 'READY', updated_at = now() 
             WHERE workflow_id = $1 AND node_key = $2`,
            [workflowId, nodeKey]
          );
          return true;
        }
        return false;
      })
    );
  }

  async transitionNodeToBlockedIfPending(workflowId: string, nodeKey: string): Promise<boolean> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        await tx.advisoryLock(`workflow-node:${workflowId}:${nodeKey}`);
        
        const rows = await tx.query<Row>(
          `UPDATE workflow_nodes 
           SET status = 'BLOCKED', updated_at = now()
           WHERE workflow_id = $1 AND node_key = $2 
             AND status IN ('WAITING_DEPENDENCIES', 'READY', 'CLAIMED')
           RETURNING id`,
          [workflowId, nodeKey]
        );
        
        return rows.length > 0;
      })
    );
  }
}
