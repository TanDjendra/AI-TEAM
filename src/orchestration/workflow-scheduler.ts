import type { Logger } from "../domain/logger.js";
import type { Persistence } from "../persistence/container.js";
import type { TaskWorker } from "./worker.js";
import type { TaskRecord } from "../domain/types.js";
import { WorkerPool } from "./worker-pool.js";
import type { IntegrationCoordinator } from "./integration-coordinator.js";

export interface WorkflowSchedulerOptions {
  persistence: Persistence;
  worker: TaskWorker;
  logger: Logger;
  pollIntervalMs?: number;
  /** Phase V2-08: maximum concurrent workflow nodes (default 4). */
  workerPoolSize?: number;
  integrationCoordinator?: IntegrationCoordinator;
}

export class WorkflowScheduler {
  private readonly persistence: Persistence;
  private readonly worker: TaskWorker;
  private readonly logger: Logger;
  private readonly pool: WorkerPool;
  private readonly workerPoolSize: number;
  private readonly integrationCoordinator?: IntegrationCoordinator;

  constructor(options: WorkflowSchedulerOptions) {
    this.persistence = options.persistence;
    this.worker = options.worker;
    this.logger = options.logger.child({ service: "workflow-scheduler" });
    this.workerPoolSize = Math.max(1, Math.min(16, options.workerPoolSize ?? 4));
    this.integrationCoordinator = options.integrationCoordinator;

    const pollIntervalMs = Math.max(1000, options.pollIntervalMs ?? 2000);

    this.pool = new WorkerPool({
      poolSize: this.workerPoolSize,
      tryClaimWork: () => this.tryClaimWork(),
      pollIntervalMs,
      logger: this.logger,
    });
  }

  start(): void {
    this.logger.info("scheduler.started", {
      workerPoolSize: this.workerPoolSize,
    });
    this.pool.start();
  }

  async stop(): Promise<void> {
    await this.pool.stop();
    this.logger.info("scheduler.stopped", { message: "Scheduler and pool stopped." });
  }

  // ---------------------------------------------------------------------------
  // Core claim logic — called by the WorkerPool for each available slot
  // ---------------------------------------------------------------------------

  /**
   * Attempts to atomically claim one READY workflow node and dispatch it.
   *
   * Returns:
   *  - `null` if no READY nodes are available (fast — just a DB query).
   *  - An object with `laneLifetime` that resolves when the dispatched task finishes.
   */
  private async tryClaimWork(): Promise<{ laneLifetime: Promise<void> } | null> {
    try {
      const claim = await this.persistence.repositories.workflows.claimNextReady(
        undefined,
        this.persistence.repositories.tasks,
      );

      if (!claim.claimed || !claim.node || !claim.taskId) {
        return null;
      }

      this.logger.info("scheduler.claimed_node", {
        workflowId: claim.node.workflowId,
        nodeKey: claim.node.nodeKey,
        taskId: claim.taskId,
      });

      const workflow = await this.persistence.repositories.workflows.findById(claim.node.workflowId);
      if (!workflow) {
        this.logger.warn("scheduler.workflow_not_found_after_claim", {
          workflowId: claim.node.workflowId,
        });
        return null;
      }

      const nodeDecl = workflow.spec.nodes.find((n: any) => n.key === claim.node!.nodeKey);

      // Build the lane lifetime promise — it resolves when the task's
      // onFinished callback fires (or when start itself fails).
      const laneLifetime = new Promise<void>((resolve) => {
        const startPromise = this.worker.start(claim.taskId!, {
          spec: {
            id: claim.taskId!,
            title: claim.node!.title,
            description: nodeDecl?.description ?? workflow.spec.objective,
            acceptanceCriteria: nodeDecl?.acceptanceCriteria ? [...nodeDecl.acceptanceCriteria] : undefined,
            workspaceSlug: workflow.spec.workspaceBinding.slug,
            workspacePath: workflow.spec.workspaceBinding.path,
          },
          reason: "workflow_scheduler",
          onFinished: async (record) => {
            try {
              await this.onTaskFinished(claim.node!.workflowId, claim.node!.nodeKey, record);
            } finally {
              resolve();
            }
          },
        });

        startPromise.then((outcome) => {
          if (!outcome.ok) {
            this.logger.warn("scheduler.worker_start_failed", {
            workflowId: claim.node!.workflowId,
            nodeKey: claim.node!.nodeKey,
            reason: outcome.reason,
          });
          // Start failed — no onFinished will fire, so resolve now.
          resolve();
        }
      }).catch((error) => {
        this.logger.error("scheduler.worker_start_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        resolve();
      });
    });

    return { laneLifetime };
    } catch (e) {
      console.error("CLAIM ERROR CAUGHT:", e);
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Post-task lifecycle (unchanged from V2-05)
  // ---------------------------------------------------------------------------

  private async onTaskFinished(
    workflowId: string,
    nodeKey: string,
    inMemoryRecord: TaskRecord,
  ): Promise<void> {
    try {
      // 1. Re-read the authoritative persisted task record.
      const persistedTask = await this.persistence.repositories.tasks.findByExternalId(inMemoryRecord.id);
      console.log("onTaskFinished", { inMemoryRecordId: inMemoryRecord.id, persistedTask });
      if (!persistedTask) {
        this.logger.error("scheduler.task_not_found", { taskId: inMemoryRecord.id });
        return;
      }

      // 2. Determine final node status.
      let finalStatus: "SUCCEEDED" | "BLOCKED" = "BLOCKED";
      let blockReason = "";

      if (persistedTask.status === "DONE") {
        if (persistedTask.approved) {
          // Check if it requires a merge
          const allocs = await this.persistence.db.query<{ mode: string, branchName: string }>(
            "SELECT mode, branch_name as \"branchName\" FROM workspace_allocations WHERE task_id = $1 LIMIT 1",
            [persistedTask.id]
          );

          if (allocs.length > 0 && allocs[0]?.mode === "GIT_WORKTREE") {
            if (this.integrationCoordinator) {
              try {
                await this.integrationCoordinator.proposeMerge(
                  workflowId,
                  nodeKey,
                  allocs[0].branchName,
                  "HEAD"
                );
                // We pause execution of this node. It remains in RUNNING state or we can mark it BLOCKED.
                // The blueprint says "pause execution". We'll just return early so the node stays RUNNING.
                // A complete implementation would wait for INTEGRATION_MERGED to mark it SUCCEEDED.
                this.logger.info("scheduler.merge_proposed_paused", { workflowId, nodeKey });
                return;
              } catch (e) {
                blockReason = `Merge proposal failed: ${e instanceof Error ? e.message : String(e)}`;
              }
            } else {
              // Proceed as normal if no coordinator is wired
              finalStatus = "SUCCEEDED";
            }
          } else {
            finalStatus = "SUCCEEDED";
          }
        } else {
          blockReason = "Task was DONE but not approved.";
        }
      } else if (persistedTask.status === "NEEDS_HUMAN" || persistedTask.status === "CANCELLED") {
        blockReason = `Task ended in ${persistedTask.status} (${persistedTask.stopReason ?? "unknown"}).`;
      }

      // 3. Update the node status.
      await this.persistence.repositories.workflows.updateNodeStatus(workflowId, nodeKey, finalStatus);
      this.logger.info("scheduler.node_finished", { workflowId, nodeKey, finalStatus });

      if (finalStatus === "SUCCEEDED") {
        await this.propagateSuccessors(workflowId, nodeKey);
      } else {
        await this.cascadeBlocked(workflowId, nodeKey, blockReason);
      }

      await this.evaluateWorkflowCompletion(workflowId);

    } catch (error) {
      this.logger.error("scheduler.onTaskFinished_failed", {
        workflowId,
        nodeKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async propagateSuccessors(
    workflowId: string,
    completedNodeKey: string,
  ): Promise<void> {
    const successors = await this.persistence.repositories.workflowDependencies.findSuccessors(workflowId, completedNodeKey);
    
    for (const successorKey of successors) {
      const becameReady = await this.persistence.repositories.workflows.evaluateAndTransitionNodeToReady(workflowId, successorKey);
      if (becameReady) {
        this.logger.info("scheduler.node_ready", { workflowId, nodeKey: successorKey });
      }
    }
  }

  private async cascadeBlocked(
    workflowId: string,
    startNodeKey: string,
    reason: string,
  ): Promise<void> {
    const queue = [startNodeKey];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const key = queue.shift()!;
      const successors = await this.persistence.repositories.workflowDependencies.findSuccessors(workflowId, key);
      
      for (const successorKey of successors) {
        if (visited.has(successorKey)) continue;
        
        const wasBlocked = await this.persistence.repositories.workflows.transitionNodeToBlockedIfPending(workflowId, successorKey);
        
        if (wasBlocked) {
          this.logger.info("scheduler.node_blocked", { workflowId, nodeKey: successorKey, reason });
          visited.add(successorKey);
          queue.push(successorKey);
        }
      }
    }
  }

  private async evaluateWorkflowCompletion(workflowId: string): Promise<void> {
    const nodes = await this.persistence.repositories.workflows.findNodes(workflowId);
    
    const allSucceeded = nodes.every((n: any) => n.status === "SUCCEEDED");
    const anyBlocked = nodes.some((n: any) => n.status === "BLOCKED" || n.status === "CANCELLED");
    
    if (allSucceeded) {
      await this.persistence.repositories.workflows.updateStatus(workflowId, "SUCCEEDED");
      this.logger.info("scheduler.workflow_succeeded", { workflowId });
    } else if (anyBlocked) {
      const workflow = await this.persistence.repositories.workflows.findById(workflowId);
      if (workflow && (workflow.status === "RUNNING" || workflow.status === "VALIDATED")) {
        await this.persistence.repositories.workflows.updateStatus(workflowId, "FAILED");
        this.logger.info("scheduler.workflow_failed", { workflowId });
      }
    }
  }
}
