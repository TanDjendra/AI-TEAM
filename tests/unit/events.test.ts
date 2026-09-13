import { describe, expect, it } from "vitest";

import {
  TASK_EVENT_TYPES,
  isEventOfType,
  isTerminalEvent,
  type TaskEvent,
} from "../../src/events/types.js";
import { createEventBus, makeEvent } from "../../src/events/bus.js";
import { InMemoryEventTransport } from "../../src/events/transports.js";

describe("event model", () => {
  it("exposes exactly the event types the specification requires", () => {
    const required = [
      "TASK_CREATED",
      "TASK_ASSIGNED",
      "TASK_STARTED",
      "STATE_CHANGED",
      "AGENT_STARTED",
      "AGENT_FINISHED",
      "TOOL_STARTED",
      "TOOL_FINISHED",
      "FILE_CHANGED",
      "TEST_STARTED",
      "TEST_FINISHED",
      "SUBMITTED_FOR_REVIEW",
      "REVIEW_STARTED",
      "REVIEW_FINISHED",
      "REVIEW_REJECTED",
      "FIX_STARTED",
      "TASK_APPROVED",
      "TASK_COMPLETED",
      "TASK_FAILED",
      "TASK_PAUSED",
      "TASK_RESUMED",
      "TASK_CANCELLED",
    ];

    for (const type of required) {
      expect(TASK_EVENT_TYPES, `missing event type ${type}`).toContain(type);
    }
  });

  it("builds a well-formed event", () => {
    const event = makeEvent({
      type: "TASK_STARTED",
      taskId: "TASK-001",
      payload: { workspace: "/ws", maxReviewCycles: 3 },
      id: "evt-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(event.id).toBe("evt-1");
    expect(event.type).toBe("TASK_STARTED");
    expect(event.taskId).toBe("TASK-001");
    expect(event.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(event.payload.workspace).toBe("/ws");
  });

  it("carries optional agentId and cycle", () => {
    const event = makeEvent({
      type: "AGENT_STARTED",
      taskId: "TASK-001",
      agentId: "coder-agent",
      cycle: 2,
      payload: {
        agentId: "coder-agent",
        role: "coder",
        model: "m",
        cycle: 2,
        attempt: 1,
        runReason: "FIX",
      },
    });

    expect(event.agentId).toBe("coder-agent");
    expect(event.cycle).toBe(2);
  });

  it("generates a unique id by default", () => {
    const a = makeEvent({ type: "TASK_STARTED", taskId: "T", payload: { workspace: "/w", maxReviewCycles: 1 } });
    const b = makeEvent({ type: "TASK_STARTED", taskId: "T", payload: { workspace: "/w", maxReviewCycles: 1 } });
    expect(a.id).not.toBe(b.id);
  });

  it("identifies terminal events", () => {
    expect(isTerminalEvent("TASK_COMPLETED")).toBe(true);
    expect(isTerminalEvent("TASK_FAILED")).toBe(true);
    expect(isTerminalEvent("TASK_CANCELLED")).toBe(true);
    expect(isTerminalEvent("STATE_CHANGED")).toBe(false);
  });

  it("narrows by type", () => {
    const event: TaskEvent<"STATE_CHANGED"> = makeEvent({
      type: "STATE_CHANGED",
      taskId: "T",
      payload: { from: "CODING", to: "TESTING", cycle: 1 },
    });

    expect(isEventOfType(event, "STATE_CHANGED")).toBe(true);
    expect(isEventOfType(event, "TASK_APPROVED")).toBe(false);
  });
});

describe("event bus with typed payloads", () => {
  it("preserves the payload through publish and replay", async () => {
    const bus = createEventBus({ newId: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })() });
    const transport = new InMemoryEventTransport();
    bus.addTransport(transport);

    await bus.publish(
      makeEvent({
        type: "REVIEW_FINISHED",
        taskId: "TASK-1",
        cycle: 2,
        payload: {
          reviewer: "reviewer-agent",
          cycle: 2,
          verdict: "REJECTED",
          severity: "HIGH",
          issues: ["missing test"],
          requiredFixes: ["add a test"],
          summary: "not good enough",
        },
      }),
    );

    const [received] = transport.all();
    expect(received?.type).toBe("REVIEW_FINISHED");
    const payload = received?.payload as { verdict: string; requiredFixes: string[] };
    expect(payload.verdict).toBe("REJECTED");
    expect(payload.requiredFixes).toEqual(["add a test"]);
    expect(bus.recent()).toHaveLength(1);

    await bus.close();
  });
});
