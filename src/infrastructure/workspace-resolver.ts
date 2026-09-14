import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskSpec } from "../domain/types.js";
import type { Logger } from "../domain/logger.js";

const exec = promisify(execFile);

export interface WorkspaceResolver {
  resolve(task: TaskSpec): Promise<string>;
  cleanup(task: TaskSpec, workspacePath: string): Promise<void>;
}

export class DirectoryWorkspaceResolver implements WorkspaceResolver {
  constructor(
    private readonly workspaceRoot: string,
    private readonly logger: Logger,
  ) {}

  async resolve(task: TaskSpec): Promise<string> {
    const slug = task.workspaceSlug ?? task.id;
    const dir = task.workspacePath ?? join(this.workspaceRoot, slug);
    await mkdir(dir, { recursive: true });
    this.logger.debug("workspace.directory_ready", { taskId: task.id, dir });
    return dir;
  }

  async cleanup(task: TaskSpec, workspacePath: string): Promise<void> {
    // V1 behavior: Do not clean up the standard directory automatically.
  }
}

export class GitWorkspaceResolver implements WorkspaceResolver {
  constructor(
    private readonly workspaceRoot: string,
    private readonly logger: Logger,
  ) {}

  private async ensureWorktreeDir(): Promise<string> {
    const worktreesDir = join(this.workspaceRoot, ".worktrees");
    await mkdir(worktreesDir, { recursive: true });
    return worktreesDir;
  }

  private async pruneWorktrees(): Promise<void> {
    try {
      await exec("git", ["worktree", "prune"], { cwd: this.workspaceRoot });
    } catch (error) {
      this.logger.warn("workspace.git_prune_failed", { error: String(error) });
    }
  }

  async resolve(task: TaskSpec): Promise<string> {
    const worktreesDir = await this.ensureWorktreeDir();
    await this.pruneWorktrees();
    
    // Explicit override path ignores the git workspace isolation
    if (task.workspacePath) {
       await mkdir(task.workspacePath, { recursive: true });
       return task.workspacePath;
    }

    const slug = task.workspaceSlug ?? task.id;
    const worktreePath = join(worktreesDir, slug);
    
    try {
      // --detach HEAD avoids creating a new branch
      await exec("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: this.workspaceRoot });
      this.logger.debug("workspace.git_worktree_ready", { taskId: task.id, dir: worktreePath });
    } catch (error) {
      this.logger.error("workspace.git_worktree_failed", { taskId: task.id, error: String(error) });
      throw new Error(`Failed to create git worktree for task ${task.id}: ${String(error)}`);
    }

    return worktreePath;
  }

  async cleanup(task: TaskSpec, workspacePath: string): Promise<void> {
    // Don't cleanup explicit override paths
    if (task.workspacePath && task.workspacePath === workspacePath) {
      return;
    }
    
    try {
      await exec("git", ["worktree", "remove", "--force", workspacePath], { cwd: this.workspaceRoot });
      this.logger.debug("workspace.git_worktree_cleaned", { taskId: task.id, dir: workspacePath });
    } catch (error) {
      this.logger.warn("workspace.git_worktree_cleanup_failed", { taskId: task.id, dir: workspacePath, error: String(error) });
      // Fallback: forcefully delete the directory if git worktree remove failed
      try {
        await rm(workspacePath, { recursive: true, force: true });
      } catch (rmError) {
        // Ignore
      }
      await this.pruneWorktrees();
    }
  }
}
