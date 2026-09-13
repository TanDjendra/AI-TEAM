import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

describe("Workspace sandbox", () => {
  it("writes and reads a file", async () => {
    const change = await workspace.writeText("src/index.js", "export const x = 1;\n");

    expect(change).toEqual({ path: "src/index.js", action: "created", bytes: 20 });
    await expect(workspace.readText("src/index.js")).resolves.toBe("export const x = 1;\n");
  });

  it("reports an existing file as modified", async () => {
    await workspace.writeText("a.txt", "first");
    const change = await workspace.writeText("a.txt", "second");
    expect(change.action).toBe("modified");
  });

  it("rejects a path that escapes the sandbox", async () => {
    await expect(workspace.writeText("../evil.txt", "nope")).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    await expect(workspace.writeText("../../etc/passwd", "nope")).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    await expect(workspace.resolvePath("..\\..\\windows\\system32\\drivers\\etc\\hosts")).rejects.toThrowError(
      WorkspaceBoundaryError,
    );
  });

  it("does not escape via a nested .. segment", async () => {
    await expect(workspace.writeText("src/../../outside.txt", "nope")).rejects.toBeInstanceOf(
      WorkspaceBoundaryError,
    );
  });

  it("lists files while ignoring node_modules and .git", async () => {
    await workspace.writeText("src/index.js", "x");
    await workspace.writeText("node_modules/pkg/index.js", "x");
    await workspace.writeText(".git/config", "x");

    const files = (await workspace.listFiles()).map((f) => f.path);
    expect(files).toContain("src/index.js");
    expect(files).not.toContain("node_modules/pkg/index.js");
    expect(files).not.toContain(".git/config");
  });
});

describe("coder tools", () => {
  it("writes a real file and reports created/modified", async () => {
    const result = await tool("write_file").handler({
      path: "src/app.js",
      content: "console.log('hi');\n",
    });

    expect(result.meta).toEqual({ path: "src/app.js", action: "created" });
    expect(result.text).toContain("created: src/app.js");
    await expect(workspace.fileExists("src/app.js")).resolves.toBe(true);
  });

  it("refuses a write outside the workspace", async () => {
    await expect(tool("write_file").handler({ path: "../escape.txt", content: "x" })).rejects.toThrowError(
      /escapes the workspace/,
    );
  });

  it("requires the content argument", async () => {
    await expect(tool("write_file").handler({ path: "a.txt" })).rejects.toThrowError(/content/);
  });

  it("lists and reads real files", async () => {
    await workspace.writeText("src/index.js", "export const one = 1;\n");

    const listing = await tool("list_files").handler({});
    expect(listing.text).toContain("src/index.js");

    const read = await tool("read_file").handler({ path: "src/index.js" });
    expect(read.text).toContain("export const one = 1;");
  });

  it("runs a real command and returns the real exit code", async () => {
    const result = await tool("run_command").handler({
      command: 'node -e "process.exit(0)"',
    });
    expect(result.meta?.exitCode).toBe(0);
    expect(result.text).toContain("exit_code: 0");
  });

  it("captures a non-zero exit code from a failing command", async () => {
    const result = await tool("run_command").handler({
      command: 'node -e "process.exit(3)"',
    });
    expect(result.meta?.exitCode).toBe(3);
    expect(result.text).toContain("exit_code: 3");
  });

  it("captures stdout from a real process", async () => {
    const result = await tool("run_command").handler({
      command: 'node -e "console.log(\'hello-from-child\')"',
    });
    expect(result.meta?.exitCode).toBe(0);
    expect(result.text).toContain("hello-from-child");
  });

  it("times out a long-running command instead of hanging forever", async () => {
    const fastRunner = new CommandRunner({ timeoutMs: 1_500 });
    const result = await fastRunner.run('node -e "setTimeout(()=>{}, 60000)"', workspace.root);

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeLessThan(20_000);
  }, 25_000);
});

describe("CommandRunner", () => {
  it("reports the real cwd-relative execution result", async () => {
    await workspace.writeText("marker.txt", "present\n");
    const result = await runner.run('node -e "console.log(require(\'fs\').existsSync(\'marker.txt\'))"', workspace.root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("true");
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr and the exit code of a failing process", async () => {
    const result = await runner.run('node -e "console.error(\'bad things\'); process.exit(2)"', workspace.root);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("bad things");
  });

  it("scrubs secrets from captured output", async () => {
    const result = await runner.run(
      `node -e "console.log('Bearer sk-live-abcdef1234567890')"`,
      workspace.root,
    );
    expect(result.stdout).not.toContain("sk-live-abcdef1234567890");
    expect(result.stdout).toContain("[REDACTED]");
  });
});
