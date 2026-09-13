import { describe, expect, it } from "vitest";

import {
  IllegalStateTransitionError,
  allowedTransitions,
  assertTransition,
  canTransition,
  isTerminal,
  reachableTerminal,
  reviewBudgetDecision,
} from "../../src/domain/task-machine.js";
import { TASK_STATES, type TaskState } from "../../src/domain/types.js";

describe("task state machine", () => {
  describe("transition table", () => {
    it("follows the documented happy path", () => {
      const path: TaskState[] = ["PENDING", "CODING", "TESTING", "REVIEW", "APPROVED", "DONE"];
      for (let i = 0; i < path.length - 1; i++) {
        expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
      }
    });

    it("walks the rejection loop", () => {
      expect(canTransition("REVIEW", "REJECTED")).toBe(true);
      expect(canTransition("REJECTED", "FIXING")).toBe(true);
      expect(canTransition("FIXING", "TESTING")).toBe(true);
      expect(canTransition("TESTING", "REVIEW")).toBe(true);
    });

    it("requires APPROVED -> DONE so DONE is reachable at all", () => {
      expect(canTransition("APPROVED", "DONE")).toBe(true);
      expect(reachableTerminal("APPROVED")).toBe("DONE");
    });

    it("marks DONE and NEEDS_HUMAN as terminal", () => {
      expect(isTerminal("DONE")).toBe(true);
      expect(isTerminal("NEEDS_HUMAN")).toBe(true);
      for (const state of TASK_STATES) {
        if (state !== "DONE" && state !== "NEEDS_HUMAN") {
          expect(isTerminal(state)).toBe(false);
        }
      }
    });

    it("never allows skipping a phase", () => {
      const illegal: Array<[TaskState, TaskState]> = [
        ["PENDING", "REVIEW"],
        ["PENDING", "DONE"],
        ["CODING", "REVIEW"],
        ["CODING", "DONE"],
        ["TESTING", "APPROVED"],
        ["REVIEW", "DONE"],
        ["REVIEW", "FIXING"],
        ["REJECTED", "TESTING"],
        ["APPROVED", "REVIEW"],
        ["DONE", "CODING"],
        ["NEEDS_HUMAN", "CODING"],
      ];
      for (const [from, to] of illegal) {
        expect(canTransition(from, to), `${from} -> ${to} must be illegal`).toBe(false);
      }
    });

    it("has no transition out of a terminal state", () => {
      for (const state of TASK_STATES) {
        if (isTerminal(state)) {
          expect(allowedTransitions(state)).toHaveLength(0);
        }
      }
    });

    it("only ever transitions to declared states", () => {
      for (const state of TASK_STATES) {
        for (const target of allowedTransitions(state)) {
          expect(TASK_STATES).toContain(target);
        }
      }
    });
  });

  describe("assertTransition", () => {
    it("passes for a legal transition", () => {
      expect(() => assertTransition("REVIEW", "REJECTED")).not.toThrow();
    });

    it("throws an IllegalStateTransitionError for an illegal one", () => {
      try {
        assertTransition("PENDING", "DONE");
        expect.unreachable("expected assertTransition to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(IllegalStateTransitionError);
        const typed = error as IllegalStateTransitionError;
        expect(typed.from).toBe("PENDING");
        expect(typed.to).toBe("DONE");
        expect(typed.message).toContain("PENDING -> DONE");
      }
    });
  });

  describe("review budget", () => {
    it("admits exactly maxReviewCycles passes", () => {
      const budget = { maxReviewCycles: 3 };
      expect(reviewBudgetDecision(0, budget)).toEqual({ stop: false });
      expect(reviewBudgetDecision(1, budget)).toEqual({ stop: false });
      expect(reviewBudgetDecision(2, budget)).toEqual({ stop: false });
      expect(reviewBudgetDecision(3, budget)).toEqual({ stop: true, reason: "MAX_REVIEW_CYCLES" });
      expect(reviewBudgetDecision(4, budget)).toEqual({ stop: true, reason: "MAX_REVIEW_CYCLES" });
    });

    it("stops immediately when maxReviewCycles is 1", () => {
      expect(reviewBudgetDecision(0, { maxReviewCycles: 1 })).toEqual({ stop: false });
      expect(reviewBudgetDecision(1, { maxReviewCycles: 1 })).toEqual({
        stop: true,
        reason: "MAX_REVIEW_CYCLES",
      });
    });

    it("rejects a nonsensical budget", () => {
      expect(() => reviewBudgetDecision(0, { maxReviewCycles: 0 })).toThrow(RangeError);
      expect(() => reviewBudgetDecision(0, { maxReviewCycles: -1 })).toThrow(RangeError);
      expect(() => reviewBudgetDecision(0, { maxReviewCycles: 1.5 })).toThrow(RangeError);
    });
  });

  describe("stop reachability", () => {
    it("maps a stopping state to its terminal state", () => {
      expect(reachableTerminal("REVIEW")).toBe("NEEDS_HUMAN");
      expect(reachableTerminal("TESTING")).toBe("NEEDS_HUMAN");
      expect(reachableTerminal("CODING")).toBe("NEEDS_HUMAN");
      expect(reachableTerminal("APPROVED")).toBe("DONE");
      expect(reachableTerminal("DONE")).toBeUndefined();
      expect(reachableTerminal("NEEDS_HUMAN")).toBeUndefined();
    });
  });
});
