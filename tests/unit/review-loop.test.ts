import { describe, expect, it } from "vitest";

import {
  runOrchestrator,
  type RunHarnessOptions,
} from "./harness.js";
import { makeCoderOutput, makeReviewerOutput } from "../helpers/index.js";

/**
 * Review-loop behaviour, driven by scripted agents. These tests are about the
 * ORCHESTRATOR's control flow, so the agents are deterministic stand-ins — the
 * real agents are exercised against the live router in tests/live.
 */
describe("orchestrator review loop", () => {
  const base = (overrides: Partial<RunHarnessOptions> = {}) =>
    runOrchestrator({
      coderOutputs: [makeCoderOutput()],
      reviewerOutputs: [makeReviewerOutput({ verdict: "APPROVED", severity: "NONE" })],
      ...overrides,
    });

  it("approves on the first review and reaches DONE", async () => {
    const { record, cleanup } = await base();
    try {
      expect(record.state).toBe("DONE");
      expect(record.approved).toBe(true);
      expect(record.reviewCycles).toBe(1);
      expect(record.stopReason).toBeUndefined();
      expect(record.history).toEqual([
        "PENDING",
        "CODING",
        "TESTING",
        "REVIEW",
        "APPROVED",
        "DONE",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("routes APPROVED through DONE rather than jumping there", async () => {
    const { record, cleanup } = await base();
    try {
      const doneIndex = record.history.indexOf("DONE");
      expect(record.history[doneIndex - 1]).toBe("APPROVED");
    } finally {
      await cleanup();
    }
  });

  it("fixes after a rejection, then approves", async () => {
    const { record, cleanup, coderAgent, reviewerAgent } = await base({
      coderOutputs: [
        makeCoderOutput({ summary: "initial attempt" }),
        makeCoderOutput({ summary: "fixed attempt" }),
      ],
      reviewerOutputs: [
        makeReviewerOutput({
          verdict: "REJECTED",
          severity: "MEDIUM",
          issues: ["slugify does not strip leading hyphens"],
          required_fixes: ["strip leading/trailing hyphens"],
        }),
        makeReviewerOutput({ verdict: "APPROVED", severity: "NONE" }),
      ],
    });

    try {
      expect(record.state).toBe("DONE");
      expect(record.reviewCycles).toBe(2);
      expect(record.history).toEqual([
        "PENDING",
        "CODING",
        "TESTING",
        "REVIEW",
        "REJECTED",
        "FIXING",
        "TESTING",
        "REVIEW",
        "APPROVED",
        "DONE",
      ]);

      // The second coder call must be a FIX run carrying the reviewer feedback.
      expect(coderAgent.calls).toHaveLength(2);
      expect(coderAgent.calls[0]!.reason).toBe("INITIAL");
      expect(coderAgent.calls[1]!.reason).toBe("FIX");
      expect(coderAgent.calls[1]!.cycle).toBe(2);
      expect(coderAgent.calls[1]!.previousReview?.required_fixes).toEqual([
        "strip leading/trailing hyphens",
      ]);

      // Both reviews really happened.
      expect(reviewerAgent.calls).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("stops with NEEDS_HUMAN after MAX_REVIEW_CYCLES rejections", async () => {
    const { record, cleanup, coderAgent, reviewerAgent } = await base({
      maxReviewCycles: 3,
      coderOutputs: [makeCoderOutput({ summary: "attempt n" })],
      reviewerOutputs: [
        makeReviewerOutput({ verdict: "REJECTED", severity: "MEDIUM" }),
      ],
    });

    try {
      expect(record.state).toBe("NEEDS_HUMAN");
      expect(record.approved).toBe(false);
      expect(record.stopReason).toBe("MAX_REVIEW_CYCLES");
      expect(record.reviewCycles).toBe(3);

      // Exactly 3 reviews, and the loop stopped instead of starting a 4th.
      expect(reviewerAgent.calls).toHaveLength(3);
      // 1 initial coder run + 2 fixes (no fix after the final rejection).
      expect(coderAgent.calls).toHaveLength(3);
      expect(coderAgent.calls.map((call) => call.reason)).toEqual(["INITIAL", "FIX", "FIX"]);

      // History shows the loop ran three times and then stopped.
      expect(record.history.filter((state) => state === "REVIEW")).toHaveLength(3);
      expect(record.history.filter((state) => state === "FIXING")).toHaveLength(2);
      expect(record.history.at(-1)).toBe("NEEDS_HUMAN");
    } finally {
      await cleanup();
    }
  });

  it("honours a maxReviewCycles of 1", async () => {
    const { record, cleanup, reviewerAgent, coderAgent } = await base({
      maxReviewCycles: 1,
      reviewerOutputs: [makeReviewerOutput({ verdict: "REJECTED", severity: "HIGH" })],
    });

    try {
      expect(record.state).toBe("NEEDS_HUMAN");
      expect(record.reviewCycles).toBe(1);
      expect(reviewerAgent.calls).toHaveLength(1);
      expect(coderAgent.calls).toHaveLength(1);
      expect(record.history).toEqual([
        "PENDING",
        "CODING",
        "TESTING",
        "REVIEW",
        "REJECTED",
        "NEEDS_HUMAN",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("never exceeds the review budget even if the reviewer always rejects", async () => {
    const { record, cleanup, reviewerAgent } = await base({
      maxReviewCycles: 2,
      coderOutputs: [makeCoderOutput()],
      reviewerOutputs: [makeReviewerOutput({ verdict: "REJECTED", severity: "LOW" })],
    });
    try {
      expect(record.reviewCycles).toBe(2);
      expect(reviewerAgent.calls.length).toBeLessThanOrEqual(2);
      expect(record.state).toBe("NEEDS_HUMAN");
    } finally {
      await cleanup();
    }
  });

  it("stops with REVIEWER_UNAVAILABLE when the reviewer call fails", async () => {
    const { record, cleanup } = await base({
      reviewerOutputs: [
        makeReviewerOutput({
          ok: false,
          contractParsed: false,
          error: "9Router request timed out",
        }),
      ],
      maxAgentAttempts: 1,
    });

    try {
      expect(record.state).toBe("NEEDS_HUMAN");
      expect(record.stopReason).toBe("REVIEWER_UNAVAILABLE");
    } finally {
      await cleanup();
    }
  });

  it("stops with CODER_UNAVAILABLE when the coder call fails", async () => {
    const { record, cleanup } = await base({
      coderOutputs: [
        makeCoderOutput({ ok: false, contractParsed: false, error: "ECONNREFUSED" }),
      ],
      maxAgentAttempts: 1,
    });

    try {
      expect(record.state).toBe("NEEDS_HUMAN");
      expect(record.stopReason).toBe("CODER_UNAVAILABLE");
      expect(record.history).toEqual(["PENDING", "CODING", "NEEDS_HUMAN"]);
    } finally {
      await cleanup();
    }
  });

  it("retries an unparsable agent call up to maxAgentAttempts", async () => {
    const { record, cleanup, coderAgent, reviewerAgent } = await base({
      maxAgentAttempts: 2,
      coderOutputs: [
        makeCoderOutput({ ok: false, contractParsed: false, error: "garbage output" }),
        makeCoderOutput({ summary: "second attempt" }),
      ],
      reviewerOutputs: [makeReviewerOutput({ verdict: "APPROVED" })],
    });

    try {
      expect(record.state).toBe("DONE");
      expect(coderAgent.calls).toHaveLength(2);
      expect(reviewerAgent.calls).toHaveLength(1);
      expect(record.attempts.filter((a) => a.kind === "CODER")).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("lets an honest BLOCKED coder reach the reviewer instead of stopping", async () => {
    const { record, cleanup, reviewerAgent } = await base({
      coderOutputs: [
        makeCoderOutput({
          status: "BLOCKED",
          ok: false,
          tests_passed: false,
          issues: ["cannot complete without a network connection"],
        }),
      ],
      reviewerOutputs: [makeReviewerOutput({ verdict: "REJECTED", severity: "HIGH" })],
      maxReviewCycles: 1,
    });

    try {
      // BLOCKED is a legitimate answer: the reviewer judged it.
      expect(reviewerAgent.calls).toHaveLength(1);
      expect(record.stopReason).toBe("MAX_REVIEW_CYCLES");
    } finally {
      await cleanup();
    }
  });

  it("records the verdicts, severities and contract fields per cycle", async () => {
    const { record, cleanup } = await base({
      coderOutputs: [makeCoderOutput(), makeCoderOutput()],
      reviewerOutputs: [
        makeReviewerOutput({
          verdict: "REJECTED",
          severity: "HIGH",
          required_fixes: ["add a test for empty input"],
        }),
        makeReviewerOutput({ verdict: "APPROVED", severity: "NONE" }),
      ],
    });

    try {
      expect(record.cycles).toHaveLength(2);
      expect(record.cycles[0]!.reviewer?.verdict).toBe("REJECTED");
      expect(record.cycles[0]!.reviewer?.severity).toBe("HIGH");
      expect(record.cycles[0]!.coder).toBeDefined();
      expect(record.cycles[1]!.reviewer?.verdict).toBe("APPROVED");
      expect(record.cycles[0]!.testing?.testsExecuted).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe("orchestrator state history invariants", () => {
  it("never performs an illegal transition in a long rejection run", async () => {
    const { record, cleanup } = await runOrchestrator({
      maxReviewCycles: 4,
      coderOutputs: [makeCoderOutput()],
      reviewerOutputs: [makeReviewerOutput({ verdict: "REJECTED", severity: "MEDIUM" })],
    });
    try {
      const legal: Record<string, string[]> = {
        PENDING: ["CODING"],
        CODING: ["TESTING"],
        TESTING: ["REVIEW"],
        REVIEW: ["APPROVED", "REJECTED"],
        REJECTED: ["FIXING"],
        FIXING: ["TESTING"],
        APPROVED: ["DONE"],
        DONE: [],
        NEEDS_HUMAN: [],
      };

      for (let i = 0; i < record.history.length - 1; i++) {
        const from = record.history[i]!;
        const to = record.history[i + 1]!;
        const allowed = legal[from] ?? [];
        const isBudgetStop =
          (from === "REVIEW" || from === "REJECTED" || from === "TESTING" || from === "FIXING" || from === "CODING") &&
          to === "NEEDS_HUMAN";
        expect(
          allowed.includes(to) || isBudgetStop,
          `${from} -> ${to} is neither a legal edge nor a budget stop`,
        ).toBe(true);
      }

      expect(record.history.at(-1)).toBe("NEEDS_HUMAN");
    } finally {
      await cleanup();
    }
  });
});
