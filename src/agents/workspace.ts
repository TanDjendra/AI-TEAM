/**
 * Workspace sandbox.
 *
 * Every filesystem path an agent asks for is resolved here and *rejected* if it
 * escapes the workspace root. The reviewer never gets one of these, which is how
 * "reviewer has no filesystem access" is enforced structurally rather than by
 * convention.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

export class WorkspaceBoundaryError extends Error {
  readonly requestedPath: string;

  constructor(requestedPath: string, workspaceRoot: string) {
    super(`Path "${requestedPath}" escapes the workspace root "${workspaceRoot}"`);
    this.name = "WorkspaceBoundaryError";
    this.requestedPath = requestedPath;
  }
}

export interface FileChange {
  path: string;
  action: "created" | "modified";
  bytes: number;
}

export interface FileEntry {
  path: string;
  bytes: number;
}

const DEFAULT_IGNORES: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".cache",
  ".venv",
  "target",
  "__pycache__",
];

export class Workspace {
  readonly root: string;
  private readonly writes = new Map<string, { hash: string; bytes: number }>();
  private readonly createdPaths = new Set<string>();

  constructor(root: string, options?: { createIfNotExists?: boolean }) {
    const resolved = resolve(root);
    if (options?.createIfNotExists === false) {
      if (!existsSync(resolved)) {
        throw new Error(`Workspace path does not exist: ${resolved}`);
      }
    } else {
      mkdirSync(resolved, { recursive: true });
    }
    this.root = realpathSync(resolved);
  }

  /**
   * Resolves a caller-supplied path inside the sandbox.
   *
   * Traversal is rejected, never silently repaired: `..` segments and absolute
   * paths are checked against the root after resolution, so "../evil.txt" throws
   * instead of being quietly rewritten to "evil.txt".
   */
  async resolvePath(candidate: string): Promise<string> {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      throw new WorkspaceBoundaryError(String(candidate), this.root);
    }

    // Normalise Windows separators so the same rules apply on every platform.
    const portable = candidate.trim().replace(/\\/g, "/");
    if (portable.startsWith("/") || /^[a-zA-Z]:/.test(portable)) {
      throw new WorkspaceBoundaryError(candidate, this.root);
    }

    const absolute = resolve(this.root, portable);
    if (absolute === this.root) return absolute;

    const rel = relative(this.root, absolute);
    const escapes = rel.startsWith("..") || isAbsolute(rel);
    if (escapes) {
      throw new WorkspaceBoundaryError(candidate, this.root);
    }

    // Symlink / Junction check (Realpath)
    // Find the nearest existing path and ensure its real path is within root.
    let current = absolute;
    let real = "";
    while (true) {
      try {
        const { realpath } = await import("node:fs/promises");
        real = await realpath(current);
        break; // Found an existing path
      } catch (e: any) {
        if (e.code === "ENOENT") {
          const parent = resolve(current, "..");
          if (parent === current) break;
          current = parent;
        } else {
          throw e;
        }
      }
    }

    if (real) {
      // Because we use this.root (which should be realpath'd), we can check safely.
      const realRel = relative(this.root, real);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        throw new WorkspaceBoundaryError(`${candidate} (resolves outside via symlink)`, this.root);
      }
    }

    return absolute;
  }

  /** Same check for directories, creating them on demand. */
  async ensureDir(relativePath: string): Promise<string> {
    const target = await this.resolvePath(relativePath);
    await mkdir(target, { recursive: true });
    return target;
  }

  async dirExists(relativePath: string): Promise<boolean> {
    return pathIsDirectory(await this.resolvePath(relativePath));
  }

  async listFiles(options: { ignores?: readonly string[]; maxFiles?: number } = {}): Promise<FileEntry[]> {
    const ignores = new Set(options.ignores ?? DEFAULT_IGNORES);
    const maxFiles = options.maxFiles ?? 2_000;
    const out: FileEntry[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (out.length >= maxFiles) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= maxFiles) return;
        if (ignores.has(entry.name)) continue;
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          const info = await stat(absolute).catch(() => undefined);
          out.push({
            path: relative(this.root, absolute).replace(/\\/g, "/"),
            bytes: info?.size ?? 0,
          });
        }
      }
    };

    await walk(this.root);
    return out;
  }

  async fileExists(relativePath: string): Promise<boolean> {
    const info = await stat(await this.resolvePath(relativePath)).catch(() => undefined);
    return info?.isFile() === true;
  }

  async readText(relativePath: string, maxBytes = 60_000): Promise<string> {
    const absolute = await this.resolvePath(relativePath);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`Not a file: ${relativePath}`);
    const content = await readFile(absolute, "utf8");
    return content.length > maxBytes ? `${content.slice(0, maxBytes)}\n…[truncated]` : content;
  }

  /** Writes a file, recording whether it was created or modified. */
  async writeText(relativePath: string, content: string): Promise<FileChange> {
    const absolute = await this.resolvePath(relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });

    const existedBefore = await pathIsFile(absolute);
    await writeFile(absolute, content, "utf8");

    const bytes = Buffer.byteLength(content, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    this.writes.set(relativePath.replace(/\\/g, "/"), { hash, bytes });
    if (!existedBefore) this.createdPaths.add(relativePath.replace(/\\/g, "/"));

    return {
      path: relativePath.replace(/\\/g, "/"),
      action: existedBefore ? "modified" : "created",
      bytes,
    };
  }

  /** Diffs the files the agent wrote against the pre-run snapshot. */
  diffChanges(baseline: ReadonlyMap<string, string>): FileChange[] {
    const changes: FileChange[] = [];
    for (const [path, { bytes }] of this.writes) {
      const before = baseline.get(path);
      if (before === undefined) {
        changes.push({ path, action: this.createdPaths.has(path) ? "created" : "modified", bytes });
      } else {
        changes.push({ path, action: "modified", bytes });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() === true;
}

async function pathIsDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  return info?.isDirectory() === true;
}

/** Snapshot of a workspace used to attribute changes to a single agent run. */
export async function snapshotWorkspace(workspace: Workspace): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const entry of await workspace.listFiles({ maxFiles: 5_000 })) {
    try {
      const content = await workspace.readText(entry.path, 2_000);
      snapshot.set(entry.path, createHash("sha256").update(content).digest("hex"));
    } catch {
      snapshot.set(entry.path, "");
    }
  }
  return snapshot;
}
