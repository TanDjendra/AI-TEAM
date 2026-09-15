import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "../domain/logger.js";
import type { IntegrationCandidate, IntegrationCandidateRepository } from "../domain/integration.js";
import type { EventBus } from "../events/bus.js";
import { makeEvent } from "../events/bus.js";

const exec = promisify(execFile);

export class IntegrationCoordinator {
  constructor(
    private readonly projectRoot: string,
    private readonly integrationRepo: IntegrationCandidateRepository,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  /**
   * Proposes a merge from sourceBranch to targetBranch.
   * If there are merge conflicts, it immediately rejects it.
   */
  async proposeMerge(
    workflowId: string,
    nodeKey: string,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<IntegrationCandidate> {
    // 1. Check if merge is possible without conflicts (Dry run)
    let diffSummary = "";
    try {
      const { stdout } = await exec("git", ["diff", "--stat", `${targetBranch}...${sourceBranch}`], {
        cwd: this.projectRoot,
      });
      diffSummary = stdout.trim() || "No changes";
      
      // Perform a dry-run merge-tree to check for conflicts
      const mergeCheck = await exec("git", ["merge-tree", targetBranch, sourceBranch], {
        cwd: this.projectRoot,
      });
      
      // merge-tree outputs conflict sections if any.
      if (mergeCheck.stdout.includes("<<<<<<<")) {
        throw new Error("Merge conflicts detected.");
      }
    } catch (err) {
      this.logger.warn("integration.propose_failed_conflicts", {
        workflowId,
        sourceBranch,
        targetBranch,
        error: String(err),
      });
      throw new Error(`Cannot propose integration: merge conflicts detected or branches invalid. ${String(err)}`);
    }

    // 2. Persist the candidate
    const candidate = await this.integrationRepo.create({
      workflowId,
      nodeId: nodeKey,
      sourceBranch,
      targetBranch,
      diffSummary,
    });

    this.logger.info("integration.proposed", { candidateId: candidate.id, workflowId });

    // 3. Emit Event
    this.bus.publish(makeEvent({
      type: "INTEGRATION_PROPOSED",
      taskId: "system",
      payload: {
        integrationId: candidate.id,
        workflowId,
        nodeKey,
        sourceBranch,
        targetBranch,
      },
    }));

    return candidate;
  }

  /**
   * Approves an integration candidate. (Human interaction)
   */
  async approve(candidateId: string): Promise<IntegrationCandidate> {
    const candidate = await this.integrationRepo.updateStatus(candidateId, "APPROVED");
    this.bus.publish(makeEvent({
      type: "INTEGRATION_APPROVED",
      taskId: "system",
      payload: {
        integrationId: candidate.id,
        actor: "human",
      },
    }));
    this.logger.info("integration.approved", { candidateId });
    return candidate;
  }

  /**
   * Rejects an integration candidate. (Human interaction)
   */
  async reject(candidateId: string, reason?: string): Promise<IntegrationCandidate> {
    const candidate = await this.integrationRepo.updateStatus(candidateId, "REJECTED", reason);
    this.bus.publish(makeEvent({
      type: "INTEGRATION_REJECTED",
      taskId: "system",
      payload: {
        integrationId: candidate.id,
        actor: "human",
        reason,
      },
    }));
    this.logger.info("integration.rejected", { candidateId, reason });
    return candidate;
  }

  /**
   * Executes the actual merge for an approved candidate.
   */
  async executeMerge(candidateId: string): Promise<IntegrationCandidate> {
    const candidate = await this.integrationRepo.getById(candidateId);
    if (!candidate) {
      throw new Error(`Candidate ${candidateId} not found`);
    }
    if (candidate.status !== "APPROVED") {
      throw new Error(`Cannot execute merge. Candidate status is ${candidate.status}, expected APPROVED.`);
    }

    try {
      // 1. Checkout target branch
      await exec("git", ["checkout", candidate.targetBranch], { cwd: this.projectRoot });
      // 2. Merge source branch
      await exec("git", ["merge", "--no-ff", "-m", `Merge integration ${candidate.id}`, candidate.sourceBranch], {
        cwd: this.projectRoot,
      });

      const updated = await this.integrationRepo.updateStatus(candidateId, "MERGED");

      this.bus.publish(makeEvent({
        type: "INTEGRATION_MERGED",
        taskId: "system",
        payload: {
          integrationId: candidate.id,
          workflowId: candidate.workflowId,
        },
      }));

      this.logger.info("integration.merged", { candidateId, workflowId: candidate.workflowId });
      return updated;

    } catch (err) {
      this.logger.error("integration.merge_failed", { candidateId, error: String(err) });
      
      // Try to abort merge
      try {
        await exec("git", ["merge", "--abort"], { cwd: this.projectRoot });
      } catch (e) {
        // Ignore abort errors
      }

      await this.integrationRepo.updateStatus(candidateId, "FAILED", String(err));
      throw new Error(`Merge failed for candidate ${candidateId}: ${String(err)}`);
    }
  }
}
