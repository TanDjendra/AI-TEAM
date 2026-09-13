/**
 * Run reporting. Everything here is derived from the TaskRecord, which is built
 * from real agent outputs and real recorded command exits — never from a
 * "let's assume it worked" narrative.
 */

import type { CycleRecord, TaskRecord } from "../domain/types.js";

export interface RunSummary {
  taskId: string;
  title: string;
  finalState: string;
  approved: boolean;
  stopReason?: string;
  reviewCycles: number;
  maxReviewCycles: number;
  coderCalls: number;
  reviewerCalls: number;
  totalTokens: number;
  durationMs: number;
  workspacePath: string;
  /** Truthful, machine-readable outcomes per review pass. */
  reviews: Array<{
    cycle: number;
    verdict: string;
    severity: string;
    requiredFixes: number;
    testsPassed: boolean;
    testsRun: string[];
    filesChanged: string[];
  }>;
  notes: string[];
}

export function summarizeRun(record: TaskRecord, maxReviewCycles: number): RunSummary {
  const started = Date.parse(record.startedAt);
  const finished = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();

  return {
    taskId: record.id,
    title: record.spec.title,
    finalState: record.state,
    approved: record.approved,
    ...(record.stopReason ? { stopReason: record.stopReason } : {}),
    reviewCycles: record.reviewCycles,
    maxReviewCycles,
    coderCalls: record.attempts.filter((a) => a.kind === "CODER").length,
    reviewerCalls: record.attempts.filter((a) => a.kind === "REVIEWER").length,
    totalTokens: record.attempts.reduce((sum, a) => sum + (a.usage?.totalTokens ?? 0), 0),
    durationMs: finished - started,
    workspacePath: record.workspacePath,
    reviews: record.cycles
      .filter((cycle) => cycle.reviewer !== undefined)
      .map((cycle) => asReviewRow(cycle)),
    notes: record.notes.slice(),
  };
}

function asReviewRow(cycle: CycleRecord) {
  const reviewer = cycle.reviewer!;
  return {
    cycle: cycle.cycle,
    verdict: reviewer.verdict,
    severity: reviewer.severity,
    requiredFixes: reviewer.required_fixes.length,
    testsPassed: cycle.coder?.tests_passed ?? false,
    testsRun: cycle.coder?.tests_run ?? [],
    filesChanged: cycle.coder?.files_changed ?? [],
  };
}

export function renderRunReport(record: TaskRecord, maxReviewCycles: number): string {
  const summary = summarizeRun(record, maxReviewCycles);
  const lines: string[] = [
    `# Run report — ${record.id}`,
    "",
    `- Title: ${record.spec.title}`,
    `- Final state: **${summary.finalState}**`,
    `- Approved: ${String(summary.approved)}`,
    `- Stop reason: ${summary.stopReason ?? "(completed normally)"}`,
    `- Review cycles used: ${summary.reviewCycles} / ${maxReviewCycles}`,
    `- Coder calls: ${summary.coderCalls} | Reviewer calls: ${summary.reviewerCalls}`,
    `- Total tokens: ${summary.totalTokens}`,
    `- Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
    `- Workspace: ${record.workspacePath}`,
    "",
    "## State history",
    "",
    record.history.join(" -> "),
    "",
    "## Review passes",
    "",
  ];

  if (summary.reviews.length === 0) {
    lines.push("_No review pass was reached._");
  } else {
    for (const review of summary.reviews) {
      lines.push(
        `### Cycle ${review.cycle} — ${review.verdict} (severity ${review.severity})`,
        "",
        `- Files changed (harness-verified): ${review.filesChanged.length ? review.filesChanged.join(", ") : "(none)"}`,
        `- Tests run (harness-verified): ${review.testsRun.length ? review.testsRun.join(" | ") : "(none executed)"}`,
        `- Tests passed (harness-verified): ${String(review.testsPassed)}`,
        `- Required fixes: ${review.requiredFixes}`,
        "",
      );
    }
  }

  const lastCycle = record.cycles[record.cycles.length - 1];
  if (lastCycle?.reviewer) {
    lines.push(
      "## Final reviewer verdict",
      "",
      `- Verdict: **${lastCycle.reviewer.verdict}**`,
      `- Severity: ${lastCycle.reviewer.severity}`,
      `- Summary: ${lastCycle.reviewer.summary}`,
      "",
    );
    if (lastCycle.reviewer.issues.length) {
      lines.push("### Reviewer issues", "");
      for (const issue of lastCycle.reviewer.issues) lines.push(`- ${issue}`);
      lines.push("");
    }
    if (lastCycle.reviewer.required_fixes.length) {
      lines.push("### Required fixes still outstanding", "");
      for (const fix of lastCycle.reviewer.required_fixes) lines.push(`- ${fix}`);
      lines.push("");
    }
  }

  lines.push("## Agent attempts", "");
  for (const attempt of record.attempts) {
    lines.push(
      `- [c${attempt.cycle}] ${attempt.kind} #${attempt.attempt} — ok=${String(attempt.ok)} ` +
        `${attempt.durationMs}ms${attempt.resolvedModel ? ` model=${attempt.resolvedModel}` : ""}` +
        `${attempt.error ? ` error=${attempt.error}` : ""}`,
    );
  }

  if (record.notes.length) {
    lines.push("", "## Notes", "");
    for (const note of record.notes) lines.push(`- ${note}`);
  }

  return lines.join("\n");
}
