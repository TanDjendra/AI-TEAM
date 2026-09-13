/**
 * PHASE 6 UI tests.
 *
 * Covers the operator-facing contract for human control: the confirmation step
 * for destructive actions, the capability-driven button set, and the phrasing of
 * human/stale events (a manual approval must never read like an AI approval).
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConfirmDialog } from "../../app/components/confirm-dialog.js";
import { ControlPanel, fallbackActions } from "../../app/components/control-panel.js";
import { describeEvent } from "../../app/lib/event-text.js";
import { eventTone } from "../../app/lib/status.js";
import type { TaskView } from "../../src/dashboard/service.js";
import type { AnyTaskEvent } from "../../src/events/types.js";

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    externalId: "TASK-001",
    title: "Create a string utility module",
    description: "Implement slugify and wordCount.",
    status: "PENDING",
    workspace: "D:/ws/TASK-001",
    currentCycle: 0,
    maxReviewCycles: 3,
    approved: false,
    createdAt: "2026-09-12T21:00:00.000Z",
    updatedAt: "2026-09-12T21:00:00.000Z",
    ...overrides,
  };
}

function event(type: string, payload: Record<string, unknown> = {}): AnyTaskEvent {
  return {
    id: `id-${type}`,
    type,
    taskId: "TASK-001",
    timestamp: "2026-09-12T21:00:00.000Z",
    payload,
  } as unknown as AnyTaskEvent;
}

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    const html = render(
      <ConfirmDialog open={false} title="x" description="y" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("explains the consequence and offers confirm/cancel", () => {
    const html = render(
      <ConfirmDialog
        open
        title="Cancel this task?"
        description="The task becomes CANCELLED and cannot continue without an explicit Retry."
        confirmLabel="Cancel task"
        destructive
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(html).toContain("Cancel this task?");
    expect(html).toContain("cannot continue without an explicit Retry");
    expect(html).toContain("Cancel task");
    // A real dialog, not window.confirm.
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });

  it("collects a note for the audit trail", () => {
    const html = render(
      <ConfirmDialog
        open
        title="Approve?"
        description="Overrides the reviewer."
        withNote
        noteLabel="Reason"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("<textarea");
    expect(html).toContain("Reason");
  });

  it("disables confirmation while a required note is empty", () => {
    const html = render(
      <ConfirmDialog
        open
        title="Approve?"
        description="Overrides the reviewer."
        withNote
        requireNote
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    // The server-rendered confirm button starts disabled because the note is empty.
    expect(html).toMatch(/disabled/);
    expect(html).toContain("(required)");
  });
});

describe("ControlPanel button set", () => {
  it("renders the server-provided actions only", () => {
    const html = render(
      <ControlPanel task={task({ status: "PENDING" })} actions={["start", "cancel"]} />,
    );
    expect(html).toContain("Start");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Pause");
    expect(html).not.toContain("Resume");
  });

  it("shows pause+cancel while a task is in flight", () => {
    const html = render(<ControlPanel task={task({ status: "CODING" })} actions={["pause", "cancel"]} running />);
    expect(html).toContain("Pause");
    expect(html).toContain("Cancel");
    expect(html).toContain("running in this process");
  });

  it("shows resume+cancel when paused", () => {
    const html = render(<ControlPanel task={task({ status: "PAUSED" })} actions={["resume", "cancel"]} />);
    expect(html).toContain("Resume");
    expect(html).toContain("Cancel");
  });

  it("offers retry for a stopped task, and no destructive action", () => {
    const html = render(<ControlPanel task={task({ status: "DONE", approved: true })} actions={["retry"]} />);
    expect(html).toContain("Retry");
    expect(html).not.toContain(">Cancel<");
    expect(html).not.toContain(">Pause<");
  });

  it("adds Recover only when the run looks stale", () => {
    const withoutStale = render(
      <ControlPanel task={task({ status: "CODING" })} actions={["pause", "cancel"]} />,
    );
    expect(withoutStale).not.toContain("Recover");

    const withStale = render(
      <ControlPanel task={task({ status: "CODING" })} actions={["pause", "cancel"]} stale />,
    );
    expect(withStale).toContain("Recover");
    expect(withStale).toContain("stale run");
  });

  it("falls back to the local mirror of the control table", () => {
    expect(fallbackActions("PENDING")).toEqual(["start", "cancel"]);
    expect(fallbackActions("PAUSED")).toEqual(["resume", "cancel"]);
    expect(fallbackActions("NEEDS_HUMAN")).toEqual(["retry", "approve", "cancel"]);
    expect(fallbackActions("DONE")).toEqual(["retry"]);
  });
});

describe("human + recovery event phrasing", () => {
  it("attributes human actions to the Owner, never to an agent", () => {
    for (const type of [
      "HUMAN_STARTED_TASK",
      "HUMAN_PAUSED_TASK",
      "HUMAN_RESUMED_TASK",
      "HUMAN_CANCELLED_TASK",
      "HUMAN_RETRIED_TASK",
      "HUMAN_APPROVED_TASK",
    ]) {
      const described = describeEvent(event(type, { actor: "human", action: "x" }));
      expect(described.actor, type).toBe("Owner");
      expect(described.message.length, type).toBeGreaterThan(0);
    }
  });

  it("includes the operator's note", () => {
    const described = describeEvent(event("HUMAN_PAUSED_TASK", { note: "flaky test" }));
    expect(described.detail).toBe("flaky test");
  });

  it("makes a manual approval obviously different from an AI approval", () => {
    const human = describeEvent(event("HUMAN_APPROVED_TASK", { reviewerVerdict: "REJECTED", manual: true }));
    expect(human.actor).toBe("Owner");
    expect(human.message).toContain("manually");
    // The disagreement is visible: the reviewer had rejected it.
    expect(human.detail).toContain("REJECTED");

    const ai = describeEvent(event("REVIEW_FINISHED", { verdict: "APPROVED", severity: "NONE" }, ));
    expect(ai.actor).not.toBe("Owner");
    expect(ai.message).not.toContain("manually");
  });

  it("phrases a stale run with the measured age and the action taken", () => {
    const described = describeEvent(
      event("TASK_STALE", { staleForMs: 185_000, thresholdMs: 120_000, recovery: "MARKED_INTERRUPTED" }),
    );
    expect(described.message).toContain("stale");
    expect(described.detail).toContain("185s");
    expect(described.detail).toContain("interrupted");
  });

  it("never invents a note that was not supplied", () => {
    const described = describeEvent(event("HUMAN_PAUSED_TASK", { actor: "human" }));
    expect(described.detail).toBeUndefined();
  });

  it("gives the danger tone to a stale run and ok to a human approval", () => {
    expect(eventTone("TASK_STALE")).toBe("danger");
    expect(eventTone("HUMAN_APPROVED_TASK")).toBe("ok");
    expect(eventTone("HUMAN_PAUSED_TASK")).toBe("warn");
  });
});
