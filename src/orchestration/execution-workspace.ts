import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { TaskSpec, WorkspaceAllocation, WorkspaceAllocationMode, WorkspaceAllocationStatus } from "../domain/types.js";
import type { Logger } from "../domain/logger.js";
import type { GitWorktreeManager } from "./git-worktree-manager.js";

export interface AllocationRepository {
  save(allocation: WorkspaceAllocation): Promise<void>;
  updateStatus(id: string, status: WorkspaceAllocationStatus): Promise<void>;
}

export interface WorkspaceResolver {
  resolve(task: TaskSpec): Promise<string>;
  cleanup(task: TaskSpec, workspacePath: string): Promise<void>;
}

export class ExecutionWorkspaceResolver implements WorkspaceResolver {
  private allocations = new Map<string, WorkspaceAllocation>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly logger: Logger,
    private readonly gitManager?: GitWorktreeManager,
    private readonly repository?: AllocationRepository,
  ) {}

  async resolve(task: TaskSpec): Promise<string> {
    const slug = task.workspaceSlug ?? task.id;
    const mode: WorkspaceAllocationMode = this.gitManager && !task.workspacePath ? "GIT_WORKTREE" : "DIRECTORY";
    
    // An explicit path overrides everything and is treated as a generic DIRECTORY mode.
    const targetPath = task.workspacePath ?? 
      (mode === "GIT_WORKTREE" ? join(this.workspaceRoot, ".worktrees", slug) : join(this.workspaceRoot, slug));

    const allocation: WorkspaceAllocation = {
      id: randomUUID(),
      taskId: task.id,
      mode,
      workspaceRoot: this.workspaceRoot,
      baseRef: "HEAD",
      branchName: mode === "GIT_WORKTREE" ? `ai-team/run-${randomUUID().slice(0, 8)}` : undefined,
      ownershipToken: randomUUID(),
      status: "ALLOCATED",
      createdAt: new Date().toISOString(),
    };

    if (mode === "GIT_WORKTREE" && this.gitManager) {
      await this.gitManager.initialize(join(this.workspaceRoot, ".worktrees"));
      const resolvedRef = await this.gitManager.resolveBaseRef();
      (allocation as any).baseRef = resolvedRef;
      await this.gitManager.createWorktree(targetPath, allocation.branchName!, resolvedRef);
    } else {
      await mkdir(targetPath, { recursive: true });
      this.logger.debug("workspace.directory_ready", { taskId: task.id, dir: targetPath });
    }

    this.allocations.set(targetPath, allocation);
    if (this.repository) {
      await this.repository.save(allocation).catch(err => {
        this.logger.warn("workspace.db_save_failed", { error: String(err) });
      });
    }

    return targetPath;
  }

  async cleanup(task: TaskSpec, workspacePath: string): Promise<void> {
    // Don't cleanup explicit override paths
    if (task.workspacePath && task.workspacePath === workspacePath) {
      return;
    }

    const allocation = this.allocations.get(workspacePath);
    let success = true;

    if (allocation?.mode === "GIT_WORKTREE" && this.gitManager) {
      try {
        await this.gitManager.removeWorktree(workspacePath, allocation.branchName);
      } catch (err) {
        success = false;
      }
    } else {
      // V1 Directory mode didn't automatically delete the workspace. We leave it as is or clean up if desired.
      // We will not delete the directory mode here to match V1 behavior, just mark it as cleaned.
    }

    const newStatus = success ? "CLEANED" : "FAILED_CLEANUP";
    if (allocation) {
      (allocation as any).status = newStatus;
      (allocation as any).cleanedAt = new Date().toISOString();
      if (this.repository) {
        await this.repository.updateStatus(allocation.id, newStatus).catch(err => {
          this.logger.warn("workspace.db_update_failed", { error: String(err) });
        });
      }
    }
    this.allocations.delete(workspacePath);
  }
}
