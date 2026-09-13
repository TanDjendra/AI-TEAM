import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { CommandRunner, createCoderTools } from "../../src/agents/tools.js";
import { Workspace, WorkspaceBoundaryError } from "../../src/agents/workspace.js";
import { cleanupDir, makeTempDir } from "../helpers/index.js";

let root: string;
let workspace: Workspace;
let runner: CommandRunner;

const tool = (name: string) => {
  const found = createCoderTools(workspace, runner).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
};

beforeEach(async () => {
  root = await makeTempDir();
  workspace = new Workspace(root);
  runner = new CommandRunner({ timeoutMs: 15_000 });
});

afterEach(async () => {
  await cleanupDir(root);
});

describe("Workspace sandbox symlink escapes", () => {
  it("rejects reading from a symlink pointing outside", async () => {
    const outside = await makeTempDir();
    await workspace.writeText("../../outside.txt", "secret").catch(() => {});
    
    // Manually create a symlink
    await symlink(outside, join(root, "link_to_outside"), "junction").catch(() => 
      symlink(outside, join(root, "link_to_outside"), "dir")
    );

    // This should throw because link_to_outside is actually outside
    await expect(workspace.writeText("link_to_outside/file.txt", "evil"))
      .rejects.toThrowError(/resolves outside/);
      
    await cleanupDir(outside);
  });
});
