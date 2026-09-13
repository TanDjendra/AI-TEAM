/**
 * Event phrasing tests.
 *
 * The live feed and the task timeline both render through `describeEvent`, so
 * these assertions pin the operator-facing wording and — more importantly — that
 * a message never invents information the event does not carry.
 */

import { describe, expect, it } from "vitest";

import { agentLabel, describeEvent, describeEventLine } from "../../app/lib/event-text.js";
import type { AnyTaskEvent } from "../../src/events/types.js";

function make(type: string, payload: Record<string, unknown> = {}, agentId?: string): AnyTaskEvent {
  return {
    id: `id-${type}`,
    type,
    taskId: "TASK-001",
    ...(agentId ? { agentId } : {}),
    timestamp: "2026-09-12T21:00:00.000Z",
    payload,
  } as unknown as AnyTaskEvent;
}

describe("agentLabel", () => {
  it("maps logical keys to display names", () => {
    expect(agentLabel("coder")).toBe("DeepSeek");
    expect(agentLabel("reviewer")).toBe("GPT Luna");
    expect(agentLabel("coder-agent")).toBe("DeepSeek");
    expect(agentLabel(undefined)).toBe("Orchestrator");
  });
});

describe("describeEvent", () => {
  it("phrases a tool call", () => {
    expect(describeEvent(make("TOOL_STARTED", { tool: "list_files" }, "coder")).message).toBe(
      "called list_files",
    );
  });

  it("phrases a file write with the real path", () => {
    expect(
      describeEvent(make("FILE_CHANGED", { path: "src/foo.ts", changeType: "created" }, "coder")).message,
    ).toBe("created src/foo.ts");
  });

  it("phrases a state transition with both ends", () => {
    const described = describeEvent(make("STATE_CHANGED", { from: "CODING", to: "TESTING" }));
    expect(described.message).toBe("CODING → TESTING");
  });

  it("includes the review verdict and cycle", () => {
    const described = describeEvent(
      make("REVIEW_FINISHED", { verdict: "APPROVED", severity: "NONE", cycle: 1 }, "reviewer"),
    );
    expect(described.actor).toBe("GPT Luna");
    expect(described.message).toBe("review finished: APPROVED");
    expect(described.detail).toContain("cycle 1");
  });

  it("reports a rejection with severity and issue count", () => {
    const described = describeEvent(
      make("REVIEW_REJECTED", { severity: "HIGH", issues: ["a", "b"] }, "reviewer"),
    );
    expect(described.message).toBe("rejected the task");
    expect(described.detail).toContain("2 issues");
  });

  it("distinguishes a failing test run from a passing one", () => {
    expect(describeEvent(make("TEST_FINISHED", { passed: false, exitCode: 1 }, "coder")).message).toBe(
      "tests failed",
    );
    expect(describeEvent(make("TEST_FINISHED", { passed: true, exitCode: 0 }, "coder")).message).toBe(
      "tests passed",
    );
  });

  it("attributes control actions to the owner", () => {
    const described = describeEvent(make("TASK_PAUSED", { reason: "investigating" }));
    expect(described.actor).toBe("Owner");
    expect(described.detail).toBe("investigating");
  });

  it("falls back to the raw event type for an unknown event", () => {
    expect(describeEvent(make("SOMETHING_NEW")).message).toBe("SOMETHING_NEW");
  });

  it("never invents a payload value that is missing", () => {
    // No path in the payload: the message must not fabricate one.
    const described = describeEvent(make("FILE_CHANGED", {}, "coder"));
    expect(described.message).toBe("wrote a file");
    expect(described.message).not.toMatch(/src|\//);
  });

  it("produces a single-line form for compact feeds", () => {
    expect(describeEventLine(make("TOOL_STARTED", { tool: "run_command" }, "coder"))).toBe(
      "DeepSeek called run_command",
    );
  });
});
