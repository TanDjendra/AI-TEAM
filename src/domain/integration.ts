/**
 * Domain contracts for the Staging Integration Candidate subsystem (Phase V2-10).
 */

export type IntegrationCandidateStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "MERGED"
  | "FAILED";

export interface IntegrationCandidate {
  id: string;
  workflowId: string;
  nodeId: string;
  sourceBranch: string;
  targetBranch: string;
  diffSummary: string;
  status: IntegrationCandidateStatus;
  createdAt: string;
  resolvedAt?: string;
  errorDetails?: string;
}

export interface IntegrationCandidateRepository {
  /**
   * Persists a newly proposed integration candidate.
   */
  create(
    candidate: Omit<IntegrationCandidate, "id" | "status" | "createdAt" | "resolvedAt" | "errorDetails">
  ): Promise<IntegrationCandidate>;

  /**
   * Finds a specific integration candidate by ID.
   */
  getById(id: string): Promise<IntegrationCandidate | null>;

  /**
   * Retrieves pending candidates. Optionally filtered by workflow.
   */
  getPending(workflowId?: string): Promise<IntegrationCandidate[]>;

  /**
   * Lists all integration candidates.
   */
  list(options?: { limit?: number }): Promise<IntegrationCandidate[]>;

  /**
   * Updates the status of an integration candidate.
   */
  updateStatus(
    id: string,
    status: IntegrationCandidateStatus,
    errorDetails?: string
  ): Promise<IntegrationCandidate>;
}
