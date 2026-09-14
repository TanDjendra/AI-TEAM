import type { TaskSpec, TestAssessment } from "./types.js";

export interface EvidenceFile {
  readonly path: string;
  readonly bytes: number;
  readonly excerpt: string;
  readonly truncated: boolean;
}

export interface CommandEvidence {
  readonly command: string;
  /** Actual process exit code, or null when the process never started. */
  readonly exitCode: number | null;
  readonly passed: boolean;
  readonly timedOut: boolean;
  readonly note: string;
  readonly output: string;
}

/** 
 * Bukti murni (tanpa metode workspace/filesystem) yang diberikan kepada Reviewer.
 * 
 * Sesuai arsitektur V2-01, ini adalah DTO murni tanpa kemampuan membaca/menulis file.
 */
export interface ReviewEvidence {
  readonly schemaVersion: 1;
  readonly task: TaskSpec;
  readonly verifiedFiles: readonly EvidenceFile[];
  readonly verifiedCommands: readonly CommandEvidence[];
  readonly testAssessment: TestAssessment;
  readonly verifierLimits: readonly string[];
}
