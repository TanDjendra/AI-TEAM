/**
 * WorkflowValidator unit tests.
 *
 * Tests use real TypeScript objects — no DB, no async, no mocks.
 * Every test exercises one or more of the nine validation checks.
 *
 * Coverage matrix:
 *   ✅ Valid linear chain (A → B → C)
 *   ✅ Valid diamond DAG (A → B, A → C, B → D, C → D)
 *   ✅ Valid single-node workflow (no edges)
 *   ✅ Valid workflow with profileBindings
 *   ❌ Empty nodes array
 *   ❌ Duplicate node key
 *   ❌ Edge referencing unknown node (from)
 *   ❌ Edge referencing unknown node (to)
 *   ❌ Self-edge (A → A)
 *   ❌ 2-node cycle (A → B → A)
 *   ❌ 3-node cycle (A → B → C → A)
 *   ❌ Mixed: valid nodes but multi-edge cycle
 *   ❌ Max nodes exceeded
 *   ❌ Max edges exceeded
 *   ❌ profileBindings referencing non-existent node key
 *   ❌ workspaceBinding: both slug and path provided
 *   ❌ workspaceBinding: neither slug nor path provided
 *   ✅ workspaceBinding: slug only (valid)
 *   ✅ workspaceBinding: path only (valid)
 */

import { describe, expect, it } from "vitest";

import {
  WorkflowValidator,
  type ValidationResult,
} from "../../src/orchestration/workflow-validator.js";
import type { WorkflowSpec } from "../../src/domain/workflow.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpec(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    objective: "Build and ship the feature.",
    workspaceBinding: { slug: "my-workspace" },
    nodes: [
      { key: "scaffold", title: "Scaffold project" },
      { key: "implement", title: "Implement feature" },
      { key: "review", title: "Code review" },
    ],
    edges: [
      { from: "scaffold", to: "implement" },
      { from: "implement", to: "review" },
    ],
    ...overrides,
  };
}

function assertValid(result: ValidationResult): void {
  expect(result.valid, `Expected valid but got errors: ${JSON.stringify(result.errors)}`).toBe(
    true,
  );
  expect(result.errors).toHaveLength(0);
}

function assertInvalid(result: ValidationResult, ...codes: string[]): void {
  expect(result.valid).toBe(false);
  for (const code of codes) {
    expect(
      result.errors.map((e) => e.code),
      `Expected error code "${code}" in errors: ${JSON.stringify(result.errors.map((e) => e.code))}`,
    ).toContain(code);
  }
}

const validator = new WorkflowValidator();

// ---------------------------------------------------------------------------
// Valid graphs
// ---------------------------------------------------------------------------

describe("WorkflowValidator — valid graphs", () => {
  it("accepts a valid linear chain (A → B → C)", () => {
    const result = validator.validate(makeSpec());
    assertValid(result);
  });

  it("accepts a valid diamond DAG (A → B, A → C, B → D, C → D)", () => {
    const spec = makeSpec({
      nodes: [
        { key: "A", title: "A" },
        { key: "B", title: "B" },
        { key: "C", title: "C" },
        { key: "D", title: "D" },
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "A", to: "C" },
        { from: "B", to: "D" },
        { from: "C", to: "D" },
      ],
    });
    assertValid(validator.validate(spec));
  });

  it("accepts a single-node workflow with no edges", () => {
    const spec = makeSpec({
      nodes: [{ key: "only", title: "Only node" }],
      edges: [],
    });
    assertValid(validator.validate(spec));
  });

  it("accepts a workflow with a workspaceBinding using path", () => {
    const spec = makeSpec({
      workspaceBinding: { path: "/absolute/workspace/path" },
    });
    assertValid(validator.validate(spec));
  });

  it("accepts a workflow with valid profileBindings (keys must exist in nodes)", () => {
    const spec = makeSpec({
      profileBindings: {
        scaffold: { coderModelId: "grip/deepseek-v4.1-flash" },
        review: { reviewerModelId: "grip/gpt-5.6-luna" },
      },
    });
    assertValid(validator.validate(spec));
  });

  it("accepts a workflow with no profileBindings (field is optional)", () => {
    const spec = makeSpec({ profileBindings: undefined });
    assertValid(validator.validate(spec));
  });
});

// ---------------------------------------------------------------------------
// Check 1: EMPTY_NODES
// ---------------------------------------------------------------------------

describe("WorkflowValidator — Check 1: EMPTY_NODES", () => {
  it("rejects an empty nodes array", () => {
    const spec = makeSpec({ nodes: [] });
    assertInvalid(validator.validate(spec), "EMPTY_NODES");
  });

  it("short-circuits — returns only EMPTY_NODES when nodes is empty", () => {
    const spec = makeSpec({ nodes: [] });
    const result = validator.validate(spec);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("EMPTY_NODES");
  });
});

// ---------------------------------------------------------------------------
// Check 2: DUPLICATE_NODE_KEY
// ---------------------------------------------------------------------------

describe("WorkflowValidator — Check 2: DUPLICATE_NODE_KEY", () => {
  it("rejects duplicate node keys", () => {
    const spec = makeSpec({
      nodes: [
        { key: "scaffold", title: "A" },
        { key: "scaffold", title: "B" }, // duplicate
        { key: "review", title: "C" },
      ],
      edges: [],
    });
    const result = validator.validate(spec);
    assertInvalid(result, "DUPLICATE_NODE_KEY");
    expect(result.errors.find((e) => e.code === "DUPLICATE_NODE_KEY")!.nodes).toContain(
      "scaffold",
    );
  });
});

// ---------------------------------------------------------------------------
// Check 3: UNKNOWN_DEPENDENCY_NODE
// ---------------------------------------------------------------------------

describe("WorkflowValidator — Check 3: UNKNOWN_DEPENDENCY_NODE", () => {
  it("rejects an edge whose 'from' node does not exist", () => {
    const spec = makeSpec({
      nodes: [{ key: "A", title: "A" }],
      edges: [{ from: "GHOST", to: "A" }],
    });
    assertInvalid(validator.validate(spec), "UNKNOWN_DEPENDENCY_NODE");
  });

  it("rejects an edge whose 'to' node does not exist", () => {
    const spec = makeSpec({
      nodes: [{ key: "A", title: "A" }],
      edges: [{ from: "A", to: "GHOST" }],
    });
    assertInvalid(validator.validate(spec), "UNKNOWN_DEPENDENCY_NODE");
  });

  it("reports all unknown nodes in a single error", () => {
    const spec = makeSpec({
      nodes: [{ key: "A", title: "A" }],
      edges: [
        { from: "GHOST1", to: "A" },
        { from: "A", to: "GHOST2" },
      ],
    });
    const result = validator.validate(spec);
    const err = result.errors.find((e) => e.code === "UNKNOWN_DEPENDENCY_NODE");
    expect(err).toBeDefined();
    expect(err!.nodes).toContain("GHOST1");
    expect(err!.nodes).toContain("GHOST2");
  });
});

// ---------------------------------------------------------------------------
// Check 4: SELF_EDGE
// ---------------------------------------------------------------------------

describe("WorkflowValidator — Check 4: SELF_EDGE", () => {
  it("rejects a self-edge (A → A)", () => {
    const spec = makeSpec({
      nodes: [{ key: "A", title: "A" }, { key: "B", title: "B" }],
      edges: [{ from: "A", to: "A" }],
    });
    assertInvalid(validator.validate(spec), "SELF_EDGE");
  });

  it("includes the self-referencing node key in the error", () => {
    const spec = makeSpec({
      nodes: [{ key: "loop", title: "Loop" }],
      edges: [{ from: "loop", to: "loop" }],
    });
    const result = validator.validate(spec);
    const err = result.errors.find((e) => e.code === "SELF_EDGE");
    expect(err!.nodes).toContain("loop");
  });
});

// ---------------------------------------------------------------------------
// Check 5: CYCLE_DETECTED
// ---------------------------------------------------------------------------

describe("WorkflowValidator — Check 5: CYCLE_DETECTED", () => {
  it("detects a 2-node cycle (A → B → A)", () => {
    const spec = makeSpec({
      nodes: [{ key: "A", title: "A" }, { key: "B", title: "B" }],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "A" },
      ],
    });
    assertInvalid(validator.validate(spec), "CYCLE_DETECTED");
  });

  it("detects a 3-node cycle (A → B → C → A)", () => {
    const spec = makeSpec({
      nodes: [
        { key: "A", title: "A" },
        { key: "B", title: "B" },
        { key: "C", title: "C" },
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
        { from: "C", to: "A" },
      ],
    });
    const result = validator.validate(spec);
    assertInvalid(result, "CYCLE_DETECTED");
    const err = result.errors.find((e) => e.code === "CYCLE_DETECTED");
    // All three nodes are in the cycle
    expect(err!.nodes).toContain("A");
    expect(err!.nodes).toContain("B");
    expect(err!.nodes).toContain("C");
  });

  it("detects a cycle embedded in an otherwise valid graph", () => {
    // Valid: X → Y; Cycle: A → B → A
    const spec = makeSpec({
      nodes: [
        { key: "X", title: "X" },
        { key: "Y", title: "Y" },
        { key: "A", title: "A" },
        { key: "B", title: "B" },
      ],
      edges: [
        { from: "X", to: "Y" },
        { from: "A", to: "B" },
        { from: "B", to: "A" }, // cycle
      ],
    });
    assertInvalid(validator.validate(spec), "CYCLE_DETECTED");
  });

  it("does NOT report a cycle for a diamond (A → B, A → C, B → D, C → D)", () => {
    const spec = makeSpec({
      nodes: [
        { key: "A", title: "A" },
        { key: "B", title: "B" },
        { key: "C", title: "C" },
        { key: "D", title: "D" },
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "A", to: "C" },
        { from: "B", to: "D" },
        { from: "C", to: "D" },
      ],
    });
    const result = validator.validate(spec);
    const codes = result.errors.map((e) => e.code);
    expect(codes).not.toContain("CYCLE_DETECTED");
  });
});

// ---------------------------------------------------------------------------
// Check 6 & 7: MAX_NODES_EXCEEDED / MAX_EDGES_EXCEEDED
// ---------------------------------------------------------------------------

describe("WorkflowValidator — Checks 6 & 7: size limits", () => {
  it("rejects a workflow that exceeds the custom maxNodes limit", () => {
    const smallValidator = new WorkflowValidator({ maxNodes: 2 });
    const spec = makeSpec({
      nodes: [
        { key: "A", title: "A" },
        { key: "B", title: "B" },
        { key: "C", title: "C" }, // 3 > maxNodes=2
      ],
      edges: [],
    });
    assertInvalid(smallValidator.validate(spec), "MAX_NODES_EXCEEDED");
  });

  it("rejects a workflow that exceeds the custom maxEdges limit", () => {
    const smallValidator = new WorkflowValidator({ maxEdges: 1 });
    const spec = makeSpec({
      nodes: [
        { key: "A", title: "A" },
        { key: "B", title: "B" },
        { key: "C", title: "C" },
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "C" }, // 2 edges > maxEdges=1
      ],
    });
    assertInvalid(smallValidator.validate(spec), "MAX_EDGES_EXCEEDED");
  });

  it("accepts exactly maxNodes nodes", () => {
    const v = new WorkflowValidator({ maxNodes: 3 });
    const spec = makeSpec(); // 3 nodes
    assertValid(v.validate(spec));
  });
});

// ---------------------------------------------------------------------------
// Check 8: INVALID_PROFILE_REF
// ---------------------------------------------------------------------------

describe("WorkflowValidator — Check 8: INVALID_PROFILE_REF", () => {
  it("rejects profileBindings that reference a non-existent node key", () => {
    const spec = makeSpec({
      profileBindings: {
        scaffold: { coderModelId: "some-model" },
        GHOST: { coderModelId: "some-model" }, // GHOST doesn't exist in nodes
      },
    });
    const result = validator.validate(spec);
    assertInvalid(result, "INVALID_PROFILE_REF");
    const err = result.errors.find((e) => e.code === "INVALID_PROFILE_REF");
    expect(err!.nodes).toContain("GHOST");
    expect(err!.nodes).not.toContain("scaffold");
  });
});

// ---------------------------------------------------------------------------
// Check 9: MULTIPLE_WRITE_RESOURCES
// ---------------------------------------------------------------------------

describe("WorkflowValidator — Check 9: MULTIPLE_WRITE_RESOURCES", () => {
  it("rejects workspaceBinding with both slug and path", () => {
    const spec = makeSpec({
      workspaceBinding: { slug: "my-slug", path: "/absolute/path" },
    });
    assertInvalid(validator.validate(spec), "MULTIPLE_WRITE_RESOURCES");
  });

  it("rejects workspaceBinding with neither slug nor path", () => {
    const spec = makeSpec({
      workspaceBinding: {},
    });
    assertInvalid(validator.validate(spec), "MULTIPLE_WRITE_RESOURCES");
  });

  it("accepts workspaceBinding with only slug", () => {
    const spec = makeSpec({ workspaceBinding: { slug: "my-feature" } });
    assertValid(validator.validate(spec));
  });

  it("accepts workspaceBinding with only path", () => {
    const spec = makeSpec({ workspaceBinding: { path: "/projects/my-feature" } });
    assertValid(validator.validate(spec));
  });

  it("rejects a slug that is an empty string", () => {
    const spec = makeSpec({ workspaceBinding: { slug: "  " } });
    assertInvalid(validator.validate(spec), "MULTIPLE_WRITE_RESOURCES");
  });
});

// ---------------------------------------------------------------------------
// Multiple simultaneous errors
// ---------------------------------------------------------------------------

describe("WorkflowValidator — multiple simultaneous errors", () => {
  it("reports duplicate key AND unknown node in the same result", () => {
    const spec = makeSpec({
      nodes: [
        { key: "A", title: "A" },
        { key: "A", title: "A-dup" }, // duplicate
      ],
      edges: [{ from: "GHOST", to: "A" }], // unknown node
    });
    const result = validator.validate(spec);
    assertInvalid(result, "DUPLICATE_NODE_KEY", "UNKNOWN_DEPENDENCY_NODE");
  });

  it("returns a valid:false result when any single check fails", () => {
    const spec = makeSpec({
      nodes: [{ key: "A", title: "A" }],
      edges: [{ from: "A", to: "A" }], // self-edge
    });
    expect(validator.validate(spec).valid).toBe(false);
  });
});
