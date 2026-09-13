import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, realpathSync } from "node:fs";

import { Workspace } from "../../src/agents/workspace.js";
import { workspacePathFor } from "../../src/orchestration/runner.js";

describe("Workspace sandbox", () => {
  it("creates a new directory if createIfNotExists is not explicitly false", () => {
    const tmp = join(process.cwd(), ".data", "tmp-ws-" + Date.now());
    try {
      const ws = new Workspace(tmp);
      expect(ws.root).toBe(realpathSync(tmp));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails if createIfNotExists is false and the directory does not exist", () => {
    const tmp = join(process.cwd(), ".data", "nope-ws-" + Date.now());
    expect(() => new Workspace(tmp, { createIfNotExists: false })).toThrow(/Workspace path does not exist/);
  });

  it("works if createIfNotExists is false but the directory exists", () => {
    const tmp = join(process.cwd(), ".data", "exists-ws-" + Date.now());
    mkdirSync(tmp, { recursive: true });
    try {
      const ws = new Workspace(tmp, { createIfNotExists: false });
      expect(ws.root).toBe(realpathSync(tmp));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("workspacePathFor", () => {
  it("uses workspacePath directly if available", () => {
    const actual = workspacePathFor("/base", { id: "T1", title: "", description: "", workspacePath: "/custom/path" });
    expect(actual).toBe("/custom/path");
  });

  it("falls back to base + slug if no workspacePath", () => {
    const actual = workspacePathFor("/base", { id: "T1", title: "", description: "", workspaceSlug: "my-slug" });
    expect(actual).toBe(join("/base", "my-slug"));
  });

  it("falls back to base + id if neither is present", () => {
    const actual = workspacePathFor("/base", { id: "T1", title: "", description: "" });
    expect(actual).toBe(join("/base", "T1"));
  });
});
