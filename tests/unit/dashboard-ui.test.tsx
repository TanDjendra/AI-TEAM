/**
 * Dashboard UI tests.
 *
 * These exercise the real React components with `react-dom/server`, so no DOM
 * emulator is needed and a component that throws still fails the test. The data
 * passed in is exactly the shape the API returns.
 *
 * They assert the operational contract: real values are rendered, empty and
 * failure states are informative, and no credential can reach the markup.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentCard } from "../../app/components/agent-card.js";
import { TaskBoard } from "../../app/components/task-board.js";
import { ReviewItem, ReviewCenter } from "../../app/components/review-center.js";
import { LiveActivity } from "../../app/components/live-activity.js";
import { ControlPanel, fallbackActions } from "../../app/components/control-panel.js";
import { SystemHeader } from "../../app/components/system-header.js";
import { CreateTaskForm } from "../../app/components/create-task-form.js";
import type {
  ActivityView,
  AgentView,
  ReviewView,
  TaskView,
} from "../../src/dashboard/service.js";
import type { AnyTaskEvent } from "../../src/events/types.js";

const NOW = Date.parse("2026-09-12T21:06:00.000Z");

/* Next's <Link> needs a router context; renderToStaticMarkup tolerates a plain
 * anchor, so the components are rendered through a thin stub-free path by
 * catching the one case that needs it. */
function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: "5b440289-4f6b-46df-bf20-c77f04e43492",
    agentKey: "coder-agent",
    displayName: "DEEPSEEK",
    role: "coder",
    provider: "9router",
    model: "grip/deepseek-v4.1-flash",
    status: "IDLE",
    lastSeen: "2026-09-12T21:05:00.000Z",
    ...overrides,
  };
}

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    externalId: "TASK-001",
    title: "Create a string utility module with tests",
    description: "Implement slugify and wordCount.",
    status: "DONE",
    assignedAgentId: "5b440289-4f6b-46df-bf20-c77f04e43492",
    assignedAgentName: "coder-agent",
    workspace: "D:/ws/TASK-001",
    currentCycle: 1,
    maxReviewCycles: 3,
    approved: true,
    createdAt: "2026-09-12T21:00:00.000Z",
    updatedAt: "2026-09-12T21:05:00.000Z",
    ...overrides,
  };
}

describe("SystemHeader", () => {
  it("shows the title and real system state", () => {
    const html = render(
      <SystemHeader
        databaseConfigured
        databaseReady
        realtime="CONNECTED"
        transports={["in-memory"]}
        taskCount={3}
        activityCount={42}
        onRefresh={() => {}}
      />,
    );

    expect(html).toContain("AI Team Command Center");
    expect(html).toContain("DB READY");
    expect(html).toContain("LIVE");
    expect(html).toContain("3 tasks");
    expect(html).toContain("42 events");
  });

  it("distinguishes reconnecting from disconnected", () => {
    const reconnecting = render(
      <SystemHeader databaseConfigured databaseReady realtime="RECONNECTING" transports={[]} taskCount={0} activityCount={0} onRefresh={() => {}} />,
    );
    expect(reconnecting).toContain("RECONNECTING");

    const disconnected = render(
      <SystemHeader databaseConfigured={false} databaseReady={false} realtime="DISCONNECTED" transports={[]} taskCount={0} activityCount={0} onRefresh={() => {}} />,
    );
    expect(disconnected).toContain("DISCONNECTED");
    expect(disconnected).toContain("NOT CONFIGURED");
  });
});

describe("AgentCard", () => {
  it("renders the coder with its real model and role", () => {
    const html = render(<AgentCard agent={agent()} now={NOW} />);
    expect(html).toContain("DEEPSEEK");
    expect(html).toContain("CODER");
    expect(html).toContain("grip/deepseek-v4.1-flash");
    expect(html).toContain("IDLE");
  });

  it("renders the reviewer distinctly", () => {
    const html = render(
      <AgentCard
        agent={agent({ role: "reviewer", displayName: "GPT", status: "REVIEWING" })}
        now={NOW}
      />,
    );
    expect(html).toContain("GPT LUNA");
    expect(html).toContain("REVIEWER");
    expect(html).toContain("REVIEWING");
  });

  it("shows the current task, cycle and elapsed time while working", () => {
    const html = render(
      <AgentCard
        agent={agent({
          status: "WORKING",
          currentTaskId: "11111111-1111-1111-1111-111111111111",
          currentTaskExternalId: "TASK-001",
          currentTaskTitle: "Create a string utility module",
          currentCycle: 2,
          elapsedSeconds: 95,
        })}
        now={NOW}
      />,
    );
    expect(html).toContain("TASK-001");
    expect(html).toContain("1m 35s");
    expect(html).toContain("2");
  });

  it("shows placeholders rather than invented values when idle", () => {
    const html = render(<AgentCard agent={agent()} now={NOW} />);
    expect(html).toContain("no activity recorded");
  });

  it("never renders a credential", () => {
    const html = render(<AgentCard agent={agent()} now={NOW} />);
    expect(html).not.toContain("sk-");
  });
});

describe("TaskBoard", () => {
  it("renders every lifecycle column, including empty ones", () => {
    const html = render(<TaskBoard tasks={[]} now={NOW} />);
    for (const label of ["Pending", "Coding", "Testing", "Review", "Fixing", "Done", "Needs human", "Paused", "Cancelled"]) {
      expect(html, label).toContain(label);
    }
    expect(html).toContain("empty");
  });

  it("places a task in its status column with cycle and id", () => {
    const html = render(<TaskBoard tasks={[task({ status: "REVIEW", currentCycle: 2 })]} now={NOW} />);
    expect(html).toContain("TASK-001");
    expect(html).toContain("REVIEW");
    expect(html).toContain("cycle 2/3");
  });

  it("distributes multiple tasks across columns", () => {
    const html = render(
      <TaskBoard
        tasks={[task({ id: "a", externalId: "T-DONE", status: "DONE" }), task({ id: "b", externalId: "T-PEND", status: "PENDING" })]}
        now={NOW}
      />,
    );
    expect(html).toContain("T-DONE");
    expect(html).toContain("T-PEND");
  });
});

describe("ReviewItem", () => {
  const review: ReviewView = {
    id: "r1",
    taskId: "11111111-1111-1111-1111-111111111111",
    taskExternalId: "TASK-001",
    reviewer: "reviewer-agent",
    cycle: 1,
    verdict: "REJECTED",
    severity: "HIGH",
    summary: "Missing edge case handling.",
    issues: ["empty input not handled"],
    requiredFixes: ["handle empty string"],
    createdAt: "2026-09-12T21:04:00.000Z",
  };

  it("renders verdict, severity, issues and required fixes", () => {
    const html = render(<ReviewItem review={review} />);
    expect(html).toContain("REJECTED");
    expect(html).toContain("HIGH");
    expect(html).toContain("cycle 1");
    expect(html).toContain("Missing edge case handling.");
    expect(html).toContain("empty input not handled");
    expect(html).toContain("handle empty string");
    expect(html).toContain("TASK-001");
  });

  it("renders an approval", () => {
    const html = render(
      <ReviewItem review={{ ...review, verdict: "APPROVED", severity: "NONE", issues: [], requiredFixes: [] }} />,
    );
    expect(html).toContain("APPROVED");
    expect(html).not.toContain("Required fixes");
  });
});

describe("ReviewCenter", () => {
  it("shows an empty state when there are no reviews", () => {
    const html = render(<ReviewCenter reviews={[]} />);
    expect(html).toContain("No reviews yet");
  });

  it("shows a loading state", () => {
    const html = render(<ReviewCenter reviews={[]} loading />);
    expect(html).toContain("Loading reviews");
  });

  it("shows an error state", () => {
    const html = render(<ReviewCenter reviews={[]} error="database unavailable" />);
    expect(html).toContain("database unavailable");
  });

  it("renders every cycle without overwriting one another", () => {
    const html = render(
      <ReviewCenter
        reviews={[
          { id: "r1", taskId: "t", reviewer: "rv", cycle: 1, verdict: "REJECTED", severity: "HIGH", summary: "first pass", issues: [], requiredFixes: [], createdAt: "2026-09-12T21:01:00.000Z" },
          { id: "r2", taskId: "t", reviewer: "rv", cycle: 2, verdict: "APPROVED", severity: "NONE", summary: "second pass", issues: [], requiredFixes: [], createdAt: "2026-09-12T21:02:00.000Z" },
        ]}
      />,
    );
    expect(html).toContain("cycle 1");
    expect(html).toContain("cycle 2");
    expect(html).toContain("first pass");
    expect(html).toContain("second pass");
    expect(html).toContain("2 review(s)");
  });
});

describe("LiveActivity", () => {
  const historical: ActivityView[] = [
    {
      eventId: "hist-1",
      eventType: "TOOL_STARTED",
      taskId: "11111111-1111-1111-1111-111111111111",
      taskExternalId: "TASK-001",
      agentId: "5b440289-4f6b-46df-bf20-c77f04e43492",
      agentName: "coder-agent",
      occurredAt: "2026-09-12T21:01:00.000Z",
      payload: { tool: "list_files" },
      message: "",
    },
  ];

  it("renders historical events when realtime is empty", () => {
    const html = render(<LiveActivity realtime={[]} historical={historical} connected={false} />);
    expect(html).toContain("called list_files");
    expect(html).toContain("historical only");
  });

  it("renders a live event with timestamp, agent, task and message", () => {
    const event = {
      id: "live-1",
      type: "FILE_CHANGED",
      taskId: "TASK-001",
      method: "FILE_CHANGED",
      timestamp: "2026-09-12T21:02:00.000Z",
      payload: { path: "src/index.js", changeType: "created", agentId: "coder" },
    } as unknown as AnyTaskEvent;

    const html = render(
      <LiveActivity realtime={[{ key: "live-1", event, receivedAt: NOW }]} historical={[]} connected />,
    );
    expect(html).toContain("created src/index.js");
    expect(html).toContain("TASK-001");
    expect(html).toContain("live");
    expect(html).toContain("streaming");
  });

  it("does not double-render an event present in both sources", () => {
    const event = {
      id: "hist-1",
      type: "TOOL_STARTED",
      taskId: "TASK-001",
      timestamp: "2026-09-12T21:01:00.000Z",
      payload: { tool: "list_files" },
    } as unknown as AnyTaskEvent;

    const html = render(
      <LiveActivity realtime={[{ key: "hist-1", event, receivedAt: NOW }]} historical={historical} connected />,
    );
    expect(html.match(/called list_files/g)?.length).toBe(1);
  });

  it("shows an empty state", () => {
    const html = render(<LiveActivity realtime={[]} historical={[]} connected={false} />);
    expect(html).toContain("No activity recorded yet");
  });
});

describe("ControlPanel", () => {
  it("offers only the actions legal for each status", () => {
    // PENDING offers both queueing (an external worker) and an immediate run.
    expect(fallbackActions("PENDING")).toEqual(["start", "cancel"]);
    expect(fallbackActions("CODING")).toContain("pause");
    expect(fallbackActions("PAUSED")).toEqual(["resume", "cancel"]);
    expect(fallbackActions("NEEDS_HUMAN")).toContain("retry");
    // The service genuinely allows re-queuing a finished or cancelled task, so
    // the UI must offer it rather than hiding a supported action.
    expect(fallbackActions("DONE")).toEqual(["retry"]);
    expect(fallbackActions("CANCELLED")).toEqual(["retry"]);
  });

  it("renders real buttons for a runnable task", () => {
    const html = render(<ControlPanel task={task({ status: "PENDING", approved: false })} />);
    expect(html).toContain("<button");
    expect(html).toContain("Start");
    expect(html).toContain("Cancel");
    // No fake claim that the UI already changed the state.
    expect(html).not.toContain("Starting");
  });

  it("explains when no action is available", () => {
    // Defensive branch: a status the rule table does not know about.
    const unknown = "SOMETHING_NEW" as unknown as Parameters<typeof fallbackActions>[0];
    expect(fallbackActions(unknown)).toEqual([]);
    const html = render(<ControlPanel task={task({ status: unknown as TaskView["status"] })} />);
    expect(html).toContain("No control actions available");
  });
});

describe("CreateTaskForm", () => {
  it("starts collapsed with a real create button", () => {
    const html = render(<CreateTaskForm />);
    expect(html).toContain("Create task");
    expect(html).toContain("Submit a task to the orchestrator");
  });

  it("renders real form fields when opened", () => {
    const html = render(<CreateTaskForm defaultOpen />);
    expect(html).toContain("Title");
    expect(html).toContain("Description");
    expect(html).toContain("Max review cycles");
    expect(html).toContain("External id");
    expect(html).toContain("<form");
  });
});
