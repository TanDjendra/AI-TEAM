/**
 * Human control tests (PHASE 6).
 *
 * The control table is the single source of truth for "what may a person do to a
 * task in this state?". These tests pin it, because the API, the worker and the
 * dashboard buttons all read from it: a mistake here would either offer an
 * illegal action or hide a legal one.
 */

import { describe, expect, it } from "vitest";

import {
  allowedControlActions,
  explainRefusal,
  isControlAction,
  isControlAllowed,
  isTaskInterrupt,
  TaskInterruptError,
} from "../../src/domain/control.js";
import type { TaskStatus } from "../../src/events/types.js";

const ALL_STATUSES: TaskStatus[] = [
  "PENDING",
  "CODING",
  "TESTING",
  "REVIEW",
  "REJECTED",
  "FIXING",
  "APPROVED",
  "DONE",
  "NEEDS_HUMAN",
  "PAUSED",
  "CANCELLED",
];

describe("control table", () => {
  it("offers exactly the documented actions per state", () => {
    expect(allowedControlActions("PENDING")).toEqual(["start", "cancel"]);
    expect(allowedControlActions("PAUSED")).toEqual(["resume", "cancel"]);
    expect(allowedControlActions("APPROVED")).toEqual(["approve"]);
    expect(allowedControlActions("NEEDS_HUMAN")).toEqual(["retry", "approve", "cancel"]);
    expect(allowedControlActions("DONE")).toEqual(["retry"]);
    expect(allowedControlActions("CANCELLED")).toEqual(["retry"]);
  });

  it("offers pause+cancel for every in-flight state", () => {
    for (const status of ["CODING", "TESTING", "REVIEW", "FIXING", "REJECTED"] as TaskStatus[]) {
      expect(allowedControlActions(status), status).toEqual(["pause", "cancel"]);
    }
  });

  it("never offers a destructive action on a finished task", () => {
    // DONE offers only Retry: no cancel, no pause, no start.
    const actions = allowedControlActions("DONE");
    expect(actions).not.toContain("cancel");
    expect(actions).not.toContain("pause");
    expect(actions).not.toContain("start");
  });

  it("allows exactly one explicit way out of DONE/CANCELLED", () => {
    for (const status of ["DONE", "CANCELLED"] as TaskStatus[]) {
      expect(allowedControlActions(status)).toEqual(["retry"]);
    }
  });

  it("never allows a task in flight to be started again (double-start guard)", () => {
    for (const status of ALL_STATUSES) {
      if (status === "PENDING") continue;
      expect(isControlAllowed(status, "start"), status).toBe(false);
    }
  });

  it("only allows resume from PAUSED", () => {
    for (const status of ALL_STATUSES) {
      expect(isControlAllowed(status, "resume"), status).toBe(status === "PAUSED");
    }
  });

  it("produces no duplicates for any state", () => {
    for (const status of ALL_STATUSES) {
      const actions = allowedControlActions(status);
      expect(new Set(actions).size, status).toBe(actions.length);
    }
  });

  it("validates action names", () => {
    expect(isControlAction("start")).toBe(true);
    expect(isControlAction("approve")).toBe(true);
    expect(isControlAction("nonsense")).toBe(false);
    expect(isControlAction("")).toBe(false);
  });
});

describe("explainRefusal", () => {
  it("explains a terminal state", () => {
    const refusal = explainRefusal("DONE", "cancel");
    expect(refusal.code).toBe("terminal");
    expect(refusal.message).toContain("DONE");
  });

  it("explains a resume on a task that is not paused", () => {
    expect(explainRefusal("CODING", "resume")).toMatchObject({ code: "not_paused" });
  });

  it("explains a start on a task already in flight", () => {
    expect(explainRefusal("REVIEW", "start")).toMatchObject({ code: "already_running" });
  });

  it("explains a retry on a task that is still working", () => {
    expect(explainRefusal("CODING", "retry")).toMatchObject({ code: "invalid_transition" });
  });

  it("always returns a usable message", () => {
    for (const status of ALL_STATUSES) {
      for (const action of ["start", "pause", "resume", "cancel", "retry", "approve"] as const) {
        if (isControlAllowed(status, action)) continue;
        const refusal = explainRefusal(status, action);
        expect(refusal.message.length, `${status}/${action}`).toBeGreaterThan(0);
        expect(refusal.code.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("TaskInterruptError", () => {
  it("carries the request and is recognisable", () => {
    const error = new TaskInterruptError({ intent: "pause", reason: "coffee", actor: "human" });
    expect(isTaskInterrupt(error)).toBe(true);
    expect(error.request.intent).toBe("pause");
    expect(error.message).toContain("pause");
    expect(error.message).toContain("coffee");
  });

  it("does not mistake another error for an interrupt", () => {
    expect(isTaskInterrupt(new Error("boom"))).toBe(false);
    expect(isTaskInterrupt(undefined)).toBe(false);
    expect(isTaskInterrupt("pause")).toBe(false);
  });
});
