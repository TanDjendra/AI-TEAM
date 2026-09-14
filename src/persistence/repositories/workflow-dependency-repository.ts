/**
 * PostgresWorkflowDependencyRepository — CRUD for the normalized
 * `workflow_dependencies` edge table.
 *
 * This is a dedicated repository for the edge table so it can be:
 *   a) Independently tested without a full workflow fixture.
 *   b) Injected into components that only need edge traversal (future scheduler).
 *
 * Design principle: one row per directed edge, never JSONB arrays.
 * The DB constraint `uq_workflow_dep_edge (workflow_id, from_node_key, to_node_key)`
 * enforces uniqueness; `ON CONFLICT DO NOTHING` makes createEdges idempotent.
 */

import { randomUUID } from "node:crypto";
import type { Db, UnitOfWork } from "../db.js";
import { Repository, withDbRetry } from "../db.js";
import { asString, type Row } from "../rows.js";
import type {
  WorkflowDependencyRecord,
  WorkflowDependencyRepository,
  WorkflowEdgeDecl,
} from "../../domain/workflow.js";

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function mapDependencyRow(row: Row): WorkflowDependencyRecord {
  return {
    id: asString(row.id),
    workflowId: asString(row.workflow_id),
    fromNodeKey: asString(row.from_node_key),
    toNodeKey: asString(row.to_node_key),
  };
}

// ---------------------------------------------------------------------------
// Repository implementation
// ---------------------------------------------------------------------------

export class PostgresWorkflowDependencyRepository
  extends Repository
  implements WorkflowDependencyRepository
{
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  /**
   * Bulk-inserts all edges for a workflow.
   * Idempotent: `ON CONFLICT DO NOTHING` means re-inserting the same edges
   * (e.g. after a transient failure) is always safe.
   *
   * If `edges` is empty the method is a no-op (no SQL executed).
   */
  async createEdges(workflowId: string, edges: readonly WorkflowEdgeDecl[]): Promise<void> {
    if (edges.length === 0) return;

    return withDbRetry(async () =>
      this.run(async (tx) => {
        for (const edge of edges) {
          await tx.query(
            `INSERT INTO workflow_dependencies
               (id, workflow_id, from_node_key, to_node_key)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (workflow_id, from_node_key, to_node_key) DO NOTHING`,
            [randomUUID(), workflowId, edge.from, edge.to],
          );
        }
      }),
    );
  }

  /**
   * Returns the keys of all predecessor nodes for `toNodeKey`.
   * These are the nodes that MUST SUCCEED before `toNodeKey` becomes READY.
   *
   * Indexed by `idx_wf_dep_to (workflow_id, to_node_key)`.
   */
  async findPredecessors(workflowId: string, toNodeKey: string): Promise<string[]> {
    const rows = await this.tx().query<Row>(
      `SELECT from_node_key FROM workflow_dependencies
       WHERE workflow_id = $1 AND to_node_key = $2`,
      [workflowId, toNodeKey],
    );
    return rows.map((row) => asString(row.from_node_key));
  }

  /**
   * Returns the keys of all successor nodes for `fromNodeKey`.
   * These are the nodes that become eligible once `fromNodeKey` SUCCEEDS.
   *
   * Indexed by `idx_wf_dep_from (workflow_id, from_node_key)`.
   */
  async findSuccessors(workflowId: string, fromNodeKey: string): Promise<string[]> {
    const rows = await this.tx().query<Row>(
      `SELECT to_node_key FROM workflow_dependencies
       WHERE workflow_id = $1 AND from_node_key = $2`,
      [workflowId, fromNodeKey],
    );
    return rows.map((row) => asString(row.to_node_key));
  }

  /**
   * Returns all edges for a workflow.
   * Used by the validator (offline re-validation) and the future scheduler.
   */
  async findAll(workflowId: string): Promise<WorkflowDependencyRecord[]> {
    const rows = await this.tx().query<Row>(
      `SELECT * FROM workflow_dependencies WHERE workflow_id = $1`,
      [workflowId],
    );
    return rows.map(mapDependencyRow);
  }
}
