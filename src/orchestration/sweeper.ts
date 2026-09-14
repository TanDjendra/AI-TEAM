/**
 * Automatic Stale-Run Sweeper (PHASE 7B).
 *
 * Runs periodically in the background to detect abandoned runs (where the worker
 * process died before it could release the task) and recover them according to
 * the system's policy, without human intervention.
 */

import type { Logger } from "../domain/logger.js";
import type { RecoveryPolicy, RecoveryService } from "./recovery.js";
import type { Persistence } from "../persistence/container.js";
import { makeEvent } from "../events/bus.js";

export interface StaleSweeperOptions {
  recovery: RecoveryService;
  persistence?: Persistence;
  logger: Logger;
  /** How often the sweep runs in milliseconds. */
  intervalMs: number;
  /** Policy applied to discovered stale runs. */
  policy?: RecoveryPolicy;
}

export class StaleSweeper {
  private readonly recovery: RecoveryService;
  private readonly persistence?: Persistence;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly policy: RecoveryPolicy;
  private timer?: ReturnType<typeof setInterval>;
  private isSweeping = false;

  constructor(options: StaleSweeperOptions) {
    this.recovery = options.recovery;
    this.persistence = options.persistence;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs;
    // By default, automatically interrupt the run and set the task to NEEDS_HUMAN.
    this.policy = options.policy ?? {
      markRunsInterrupted: true,
      releaseAgents: true,
      staleTaskStatus: "NEEDS_HUMAN",
    };
  }

  start(): void {
    if (this.timer) return;
    this.logger.info("sweeper.started", { intervalMs: this.intervalMs });
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    // Do an immediate initial sweep.
    void this.sweep();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger.info("sweeper.stopped", {});
    }
  }

  /** Performs a single sweep explicitly and awaits its completion. */
  async sweepOnce(): Promise<void> {
    return this.sweep();
  }

  private async sweep(): Promise<void> {
    if (this.isSweeping) return;
    this.isSweeping = true;
    try {
      const report = await this.recovery.recover(this.policy);
      if (report.applied.length > 0) {
        this.logger.warn("sweeper.recovered", {
          staleCount: report.applied.length,
          taskIds: report.applied.map((a) => a.taskExternalId),
        });
      }

      await this.sweepWorkflows();
    } catch (error) {
      this.logger.error("sweeper.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.isSweeping = false;
    }
  }

  private async sweepWorkflows(): Promise<void> {
    if (!this.persistence || !this.persistence.workflows) return;
    const thresholdMs = this.policy.markRunsInterrupted !== false ? 120_000 : 120_000;
    const nowMs = Date.now();
    const { workflows, bus, repositories: { tasks } } = this.persistence;
    
    // We get all workflows in RUNNING state
    const runningWorkflows = await workflows.list({ status: "RUNNING" });
    for (const wf of runningWorkflows) {
      const nodes = await workflows.findNodes(wf.id);
      for (const node of nodes) {
        if ((node.status === "CLAIMED" || node.status === "RUNNING") && node.currentTaskId) {
          const task = await tasks.findById(node.currentTaskId);
          if (!task) continue;
          
          const reference = task.heartbeatAt ?? task.startedAt ?? task.updatedAt;
          const parsed = Date.parse(reference);
          const age = Number.isNaN(parsed) ? 0 : Math.max(0, nowMs - parsed);
          
          if (age > thresholdMs) {
            this.logger.warn("sweeper.workflow_node_stale", {
              workflowId: wf.id,
              nodeKey: node.nodeKey,
              taskId: task.externalId,
              staleForMs: age,
            });
            
            await workflows.updateNodeStatus(wf.id, node.nodeKey, "BLOCKED");
            await workflows.updateStatus(wf.id, "FAILED");
            
            const event = makeEvent({
              type: "WORKFLOW_NODE_BLOCKED",
              taskId: task.externalId,
              payload: {
                workflowId: wf.id,
                nodeKey: node.nodeKey,
                reason: "lease_expired",
              },
              newId: () => globalThis.crypto.randomUUID(),
              now: () => new Date(),
            } as any) as import("../events/types.js").AnyTaskEvent;
            await bus.publish(event);
            
            const wfEvent = makeEvent({
              type: "WORKFLOW_FAILED",
              taskId: task.externalId,
              payload: {
                workflowId: wf.id,
                blockedNodeKeys: [node.nodeKey],
                reason: "lease_expired",
              },
              newId: () => globalThis.crypto.randomUUID(),
              now: () => new Date(),
            } as any) as import("../events/types.js").AnyTaskEvent;
            await bus.publish(wfEvent);
          }
        }
      }
    }
  }
}
