import { Repository, type Db, type UnitOfWork } from "../db.js";
import type {
  IntegrationCandidate,
  IntegrationCandidateRepository,
  IntegrationCandidateStatus,
} from "../../domain/integration.js";

/**
 * Postgres implementation of IntegrationCandidateRepository.
 */
export class PostgresIntegrationCandidateRepository extends Repository implements IntegrationCandidateRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  async create(
    candidate: Omit<IntegrationCandidate, "id" | "status" | "createdAt" | "resolvedAt" | "errorDetails">
  ): Promise<IntegrationCandidate> {
    const res = await this.tx().query<IntegrationCandidate>(
      `
      INSERT INTO integration_candidates (workflow_id, node_id, source_branch, target_branch, diff_summary)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, workflow_id AS "workflowId", node_id AS "nodeId", source_branch AS "sourceBranch", target_branch AS "targetBranch", diff_summary AS "diffSummary", status, created_at AS "createdAt", resolved_at AS "resolvedAt", error_details AS "errorDetails"
      `,
      [
        candidate.workflowId,
        candidate.nodeId,
        candidate.sourceBranch,
        candidate.targetBranch,
        candidate.diffSummary,
      ]
    );
    return res[0]!;
  }

  async getById(id: string): Promise<IntegrationCandidate | null> {
    const res = await this.tx().query<IntegrationCandidate>(
      `
      SELECT id, workflow_id AS "workflowId", node_id AS "nodeId", source_branch AS "sourceBranch", target_branch AS "targetBranch", diff_summary AS "diffSummary", status, created_at AS "createdAt", resolved_at AS "resolvedAt", error_details AS "errorDetails"
      FROM integration_candidates
      WHERE id = $1
      `,
      [id]
    );
    return res[0] ?? null;
  }

  async getPending(workflowId?: string): Promise<IntegrationCandidate[]> {
    if (workflowId) {
      const res = await this.tx().query<IntegrationCandidate>(
        `
        SELECT id, workflow_id AS "workflowId", node_id AS "nodeId", source_branch AS "sourceBranch", target_branch AS "targetBranch", diff_summary AS "diffSummary", status, created_at AS "createdAt", resolved_at AS "resolvedAt", error_details AS "errorDetails"
        FROM integration_candidates
        WHERE status = 'PENDING' AND workflow_id = $1
        ORDER BY created_at ASC
        `,
        [workflowId]
      );
      return res;
    } else {
      const res = await this.tx().query<IntegrationCandidate>(
        `
        SELECT id, workflow_id AS "workflowId", node_id AS "nodeId", source_branch AS "sourceBranch", target_branch AS "targetBranch", diff_summary AS "diffSummary", status, created_at AS "createdAt", resolved_at AS "resolvedAt", error_details AS "errorDetails"
        FROM integration_candidates
        WHERE status = 'PENDING'
        ORDER BY created_at ASC
        `
      );
      return res;
    }
  }

  async list(options?: { limit?: number }): Promise<IntegrationCandidate[]> {
    const limit = options?.limit ?? 100;
    const res = await this.tx().query<IntegrationCandidate>(
      `
      SELECT id, workflow_id AS "workflowId", node_id AS "nodeId", source_branch AS "sourceBranch", target_branch AS "targetBranch", diff_summary AS "diffSummary", status, created_at AS "createdAt", resolved_at AS "resolvedAt", error_details AS "errorDetails"
      FROM integration_candidates
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );
    return res;
  }

  async updateStatus(
    id: string,
    status: IntegrationCandidateStatus,
    errorDetails?: string
  ): Promise<IntegrationCandidate> {
    const resolvedAt = status !== "PENDING" ? new Date().toISOString() : null;

    const res = await this.tx().query<IntegrationCandidate>(
      `
      UPDATE integration_candidates
      SET status = $1, error_details = $2, resolved_at = $3
      WHERE id = $4
      RETURNING id, workflow_id AS "workflowId", node_id AS "nodeId", source_branch AS "sourceBranch", target_branch AS "targetBranch", diff_summary AS "diffSummary", status, created_at AS "createdAt", resolved_at AS "resolvedAt", error_details AS "errorDetails"
      `,
      [status, errorDetails ?? null, resolvedAt, id]
    );

    if (res.length === 0) {
      throw new Error(`Integration candidate with ID ${id} not found.`);
    }
    return res[0]!;
  }
}
