/**
 * Shared evidence builder.
 *
 * Both the reviewer prompt and the human-readable run report are rendered from
 * this one object, so what the reviewer sees is exactly what the report claims
 * was seen. Evidence is built from the real workspace and the real recorded
 * tool executions — never from the coder's own summary.
 */

import { truncate } from "../domain/errors.js";
import type { CoderOutput, TaskSpec } from "../domain/types.js";
import type { Workspace } from "./workspace.js";

export interface EvidenceFile {
  path: string;
  bytes: number;
  excerpt: string;
  truncated: boolean;
}

export interface CommandEvidence {
  command: string;
  /** Actual process exit code, or null when the process never started. */
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  note: string;
  output: string;
}

export interface TaskEvidence {
  task: TaskSpec;
  cycle: number;
  attemptCount: number;
  coderStatus: string;
  coderSummary: string;
  coderIssues: string[];
  /** Files the harness verified were written — authoritative. */
  files: EvidenceFile[];
  /** Commands the harness verified were executed — authoritative. */
  commands: CommandEvidence[];
  testsPassed: boolean;
  testCommands: string[];
  /** Points the reviewer must check but that the harness cannot verify. */
  unverifiable: string[];
}

export interface BuildEvidenceOptions {
  workspace: Workspace;
  task: TaskSpec;
  cycle: number;
  attemptCount: number;
  coder: CoderOutput;
  /** Paths to include in full, e.g. every path in coder.files_changed. */
  extraPaths?: string[];
  /** Verified command executions recorded by the coder harness. */
  executed?: ReadonlyArray<{ command: string; exitCode: number | null; timedOut: boolean; output: string }>;
  excerptChars?: number;
  maxFiles?: number;
}

export async function buildTaskEvidence(options: BuildEvidenceOptions): Promise<TaskEvidence> {
  const {
    workspace,
    task,
    cycle,
    attemptCount,
    coder,
    extraPaths = [],
    executed = [],
    excerptChars = 2_600,
    maxFiles = 25,
  } = options;

  const wanted = new Set<string>([...coder.files_changed, ...extraPaths].map(normalise));

  const files: EvidenceFile[] = [];
  const all = await workspace.listFiles({ maxFiles: 5_000 });
  const wantedList = all.filter((entry) => wanted.has(entry.path));

  // Optimization: Only include files that were changed or explicitly requested.
  // Don't pollute the reviewer context with unmodified files unless requested.
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

  const testCommands = coder.tests_run.slice();

  // The honest list of things no harness can prove.
  const unverifiable: string[] = [];
  if (commands.length === 0) {
    unverifiable.push(
      "No command execution was recorded for this run, so the reviewer cannot confirm the tests were ever run.",
    );
  }
  if (coder.tests_passed && !commands.some((c) => c.passed)) {
    unverifiable.push(
      "The coder reports tests_passed=true but no recorded command exited 0.",
    );
  }
  unverifiable.push(
    "Command output shown is truncated; treat long logs as partial evidence.",
  );
  unverifiable.push(
    "Behaviour that no recorded command exercises (UX, runtime-only paths, external services) cannot be verified from this evidence.",
  );

  return {
    task,
    cycle,
    attemptCount,
    coderStatus: coder.status,
    coderSummary: coder.summary,
    coderIssues: coder.issues.slice(),
    files,
    commands,
    testsPassed: coder.tests_passed,
    testCommands,
    unverifiable,
  };
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^[./]+/, "");
}

/** Renders evidence for the reviewer prompt. */
export function renderEvidence(evidence: TaskEvidence): string {
  const { task } = evidence;
  const lines: string[] = [
    `TASK ID: ${task.id}`,
    `TITLE: ${task.title}`,
    `REVIEW CYCLE: ${evidence.cycle}`,
    `CODER ATTEMPTS: ${evidence.attemptCount}`,
    "",
    "TASK DESCRIPTION:",
    task.description.trim(),
  ];

  if (task.acceptanceCriteria?.length) {
    lines.push("", "ACCEPTANCE CRITERIA:");
    for (const criterion of task.acceptanceCriteria) lines.push(`- ${criterion}`);
  }

  lines.push(
    "",
    "CODER REPORT (self-reported, NOT trusted — verify against the harness record below):",
    `  status: ${evidence.coderStatus}`,
    `  tests_passed (self-reported): ${String(evidence.testsPassed)}`,
    `  test commands (self-reported): ${evidence.testCommands.length ? evidence.testCommands.join(" | ") : "(none)"}`,
    `  summary: ${evidence.coderSummary}`,
  );
  if (evidence.coderIssues.length) {
    lines.push("  declared issues:");
    for (const issue of evidence.coderIssues) lines.push(`    - ${issue}`);
  }

  lines.push("", "HARNESS-VERIFIED FILE SNAPSHOT:");
  if (evidence.files.length === 0) {
    lines.push("  (no files present in the workspace)");
  } else {
    for (const file of evidence.files) {
      lines.push(
        "",
        `--- FILE: ${file.path} (${file.bytes}B)${file.truncated ? " [truncated]" : ""} ---`,
        file.excerpt,
      );
    }
  }

  lines.push("", "HARNESS-VERIFIED COMMAND EXECUTION LOG (actual exit codes):");
  if (evidence.commands.length === 0) {
    lines.push("  (NO COMMAND WAS EXECUTED — this is itself a serious problem)");
  } else {
    for (const command of evidence.commands) {
      lines.push("", `$ ${command.command}`, `  -> ${command.note}`, indent(command.output));
    }
  }

  if (evidence.unverifiable.length) {
    lines.push("", "WHAT THE HARNESS COULD NOT VERIFY:");
    for (const item of evidence.unverifiable) lines.push(`- ${item}`);
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
