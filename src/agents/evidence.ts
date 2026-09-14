/**
 * Shared evidence builder.
 *
 * Both the reviewer prompt and the human-readable run report are rendered from
 * this one object, so what the reviewer sees is exactly what the report claims
 * was seen. Evidence is built from the real workspace and the real recorded
 * tool executions — never from the coder's own summary.
 */

import { truncate } from "../domain/errors.js";
import type { CoderOutput, TaskSpec, TestAssessment } from "../domain/types.js";
import type { ReviewEvidence, EvidenceFile, CommandEvidence } from "../domain/review-evidence.js";
import type { Workspace } from "./workspace.js";

export interface BuildEvidenceOptions {
  workspace: Workspace;
  task: TaskSpec;
  /** Paths to include in full, e.g. every path in coder.files_changed. */
  extraPaths?: string[];
  /** Verified command executions recorded by the coder harness. */
  executed?: ReadonlyArray<{ command: string; exitCode: number | null; timedOut: boolean; output: string }>;
  testAssessment: TestAssessment;
  excerptChars?: number;
  maxFiles?: number;
}

export async function buildReviewEvidence(options: BuildEvidenceOptions): Promise<ReviewEvidence> {
  const {
    workspace,
    task,
    extraPaths = [],
    executed = [],
    testAssessment,
    excerptChars = 2_600,
    maxFiles = 25,
  } = options;

  const wanted = new Set<string>(extraPaths.map(normalise));

  const files: EvidenceFile[] = [];
  const all = await workspace.listFiles({ maxFiles: 5_000 });
  const wantedList = all.filter((entry) => wanted.has(entry.path));

  for (const entry of wantedList) {
    try {
      const content = await workspace.readText(entry.path, excerptChars + 1);
      files.push({
        path: entry.path,
        bytes: entry.bytes,
        excerpt: content,
        truncated: content.length > excerptChars,
      });
    } catch {
      files.push({
        path: entry.path,
        bytes: entry.bytes,
        excerpt: "(binary or unreadable — not shown)",
        truncated: false,
      });
    }
  }

  const commands: CommandEvidence[] = executed.map((entry) => ({
    command: entry.command,
    exitCode: entry.exitCode,
    passed: entry.timedOut ? false : entry.exitCode === 0,
    timedOut: entry.timedOut,
    note: entry.timedOut ? "timed out" : entry.exitCode === 0 ? "exit 0" : `exit ${entry.exitCode ?? "null"}`,
    output: truncate(entry.output, 1_800),
  }));

  const verifierLimits: string[] = [];
  if (commands.length === 0) {
    verifierLimits.push(
      "No command execution was recorded for this run, so the reviewer cannot confirm the tests were ever run.",
    );
  }
  if (testAssessment.testsExecuted && !commands.some((c) => c.passed)) {
    verifierLimits.push(
      "The coder reports tests passed but no recorded command exited 0.",
    );
  }
  verifierLimits.push(
    "Command output shown is truncated; treat long logs as partial evidence.",
  );
  verifierLimits.push(
    "Behaviour that no recorded command exercises (UX, runtime-only paths, external services) cannot be verified from this evidence.",
  );

  return {
    schemaVersion: 1,
    task,
    verifiedFiles: files,
    verifiedCommands: commands,
    testAssessment,
    verifierLimits,
  };
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^[./]+/, "");
}

/** Renders evidence for the reviewer prompt. */
export function renderEvidence(evidence: ReviewEvidence, coder?: CoderOutput, cycle: number = 1, attemptCount: number = 1): string {
  const { task } = evidence;
  const lines: string[] = [
    `TASK ID: ${task.id}`,
    `TITLE: ${task.title}`,
    `REVIEW CYCLE: ${cycle}`,
    `CODER ATTEMPTS: ${attemptCount}`,
    "",
    "TASK DESCRIPTION:",
    task.description.trim(),
  ];

  if (task.acceptanceCriteria?.length) {
    lines.push("", "ACCEPTANCE CRITERIA:");
    for (const criterion of task.acceptanceCriteria) lines.push(`- ${criterion}`);
  }

  if (coder) {
    lines.push(
      "",
      "CODER REPORT (self-reported, NOT trusted — verify against the harness record below):",
      `  status: ${coder.status}`,
      `  tests_passed (self-reported): ${String(coder.tests_passed)}`,
      `  test commands (self-reported): ${coder.tests_run.length ? coder.tests_run.join(" | ") : "(none)"}`,
      `  summary: ${coder.summary}`,
    );
    if (coder.issues.length) {
      lines.push("  declared issues:");
      for (const issue of coder.issues) lines.push(`    - ${issue}`);
    }
  } else {
    lines.push("", "CODER REPORT: (no coder output was available for this cycle)");
  }

  lines.push("", "HARNESS-VERIFIED FILE SNAPSHOT:");
  if (evidence.verifiedFiles.length === 0) {
    lines.push("  (no files present in the workspace)");
  } else {
    for (const file of evidence.verifiedFiles) {
      lines.push(
        "",
        `--- FILE: ${file.path} (${file.bytes}B)${file.truncated ? " [truncated]" : ""} ---`,
        file.excerpt,
      );
    }
  }

  lines.push("", "HARNESS-VERIFIED COMMAND EXECUTION LOG (actual exit codes):");
  if (evidence.verifiedCommands.length === 0) {
    lines.push("  (NO COMMAND WAS EXECUTED — this is itself a serious problem)");
  } else {
    for (const command of evidence.verifiedCommands) {
      lines.push("", `$ ${command.command}`, `  -> ${command.note}`, indent(command.output));
    }
  }

  lines.push("", "HARNESS-VERIFIED TEST ASSESSMENT:");
  lines.push(`  testsExecuted: ${evidence.testAssessment.testsExecuted}`);
  lines.push(`  allCommandsPassed: ${evidence.testAssessment.allCommandsPassed}`);
  lines.push(`  reason: ${evidence.testAssessment.reason}`);

  if (evidence.verifierLimits.length) {
    lines.push("", "WHAT THE HARNESS COULD NOT VERIFY:");
    for (const item of evidence.verifierLimits) lines.push(`- ${item}`);
  }

  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .slice(0, 40)
    .map((line) => `      ${line}`)
    .join("\n");
}
