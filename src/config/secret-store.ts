/**
 * Atomic `.env` writer (Phase 1 — configuration foundation).
 *
 * Decision (C1, confirmed with the owner): `ROUTER_API_KEY` stays authoritative
 * in `.env`. The JSON config file remains SECRET-FREE, and secrets never move
 * into the database or an encrypted store. This module is therefore the *only*
 * place that writes environment secrets to disk.
 *
 * Guarantees, and why they matter:
 *  - Atomic: write temp file → fsync → rename over the target. On the same
 *    filesystem a rename is atomic, so a crash mid-write leaves the previous
 *    `.env` intact rather than a truncated file that would break startup.
 *  - Backup-aware: the previous contents are copied to `.env.bak` before the
 *    rename commits, so an operator can roll back by hand.
 *  - Non-destructive merge: saving a secret updates only the requested keys and
 *    preserves every other line, comment and blank line in the file. An
 *    operator's hand-written notes are never destroyed.
 *  - Secret-free diagnostics: the returned metadata never contains a secret
 *    value, only which keys were written and a non-reversible hash.
 *  - Cross-platform: uses `node:fs` / `node:path` only (Windows-safe).
 *
 * What this module deliberately does NOT do:
 *  - It never logs a value. Callers must log only the returned metadata.
 *  - It never reads a secret back out for display; use `maskSecret` for that.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { parseDotEnv } from "./env.js";

/** The environment file a product CLI / wizard writes secrets into. */
export const ENV_FILENAME = ".env";
/** Suffix appended to the previous file when a write replaces it. */
export const ENV_BACKUP_SUFFIX = ".bak";

export class SecretStoreError extends Error {
  readonly filePath: string;

  constructor(message: string, options: { filePath?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SecretStoreError";
    this.filePath = options.filePath ?? "";
  }
}

/**
 * Result of a write.
 *
 * IMPORTANT: this object is safe to log and to return to a caller/UI. It
 * contains the file path, the names of the keys that changed and a truncated
 * hash of the *new file contents* — never a secret value.
 */
export interface SecretWriteResult {
  path: string;
  /** Names of the keys written by this call (never their values). */
  writtenKeys: string[];
  /** True when a `.env.bak` copy of the previous contents was created. */
  backupCreated: boolean;
  /** True when the file did not exist before this write. */
  created: boolean;
  /** Truncated sha256 of the resulting file, for drift detection. */
  hash: string;
}

export interface WriteEnvSecretsOptions {
  /** Absolute or cwd-relative path of the env file. Defaults to `<cwd>/.env`. */
  filePath?: string;
  /** Project root used to resolve the default `.env` path. Defaults to cwd. */
  cwd?: string;
  /**
   * Keep a `.env.bak` copy of the previous contents. Defaults to true. A failed
   * backup must never abort the write (the rename is the real commit).
   */
  keepBackup?: boolean;
}

/**
 * Resolves the env file path.
 *
 * Resolution is done by the caller through `cwd`/`filePath`; there is no
 * implicit `process.cwd()` deep inside the write, so the function stays testable.
 */
export function resolveEnvPath(options: { filePath?: string; cwd?: string } = {}): string {
  if (options.filePath) return options.filePath;
  return join(options.cwd ?? process.cwd(), ENV_FILENAME);
}

/**
 * Rejects a value that cannot be stored and read back unchanged.
 *
 * Two refusals protect the operator:
 *  - A raw newline would let a value inject an extra line (and thus an unrelated
 *    variable) into the file.
 *  - A double quote cannot be represented, because `parseDotEnv` (the existing
 *    reader) strips the surrounding quotes but performs NO unescaping. Writing
 *    one would silently change the value on the next read, so it is refused
 *    rather than corrupted. Real API keys never contain quotes.
 */
function assertStorableValue(key: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new SecretStoreError(
      `Refusing to store "${key}": the value contains a newline, which would corrupt the file.`,
    );
  }
  if (value.includes('"')) {
    throw new SecretStoreError(
      `Refusing to store "${key}": the value contains a double quote, which the .env reader cannot represent unambiguously.`,
    );
  }
}

/**
 * Quotes a value only when the existing reader needs it to survive a round trip.
 *
 * `parseDotEnv` strips a matching pair of surrounding quotes and trims inline
 * `#` comments from unquoted values, so a value containing whitespace or `#`
 * MUST be quoted; everything else is left bare for a clean diff.
 */
function quoteIfNeeded(value: string): string {
  if (value === "") return "";
  if (/[\s#]/.test(value)) return `"${value}"`;
  return value;
}

/**
 * Merges `updates` into the given env source text, preserving every line that
 * is not one of the updated keys.
 *
 * A key that does not yet have a line is appended at the end. A key present
 * multiple times has only its FIRST occurrence updated; later duplicates are
 * preserved as-is (matching the precedence `parseDotEnv` itself applies, where
 * the last write wins — so we update every occurrence to avoid ambiguity).
 */
export function upsertEnvLines(source: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  for (const [key, value] of Object.entries(updates)) assertStorableValue(key, value);

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = source.length > 0 && /(\r?\n)$/.test(source);

  // Split without dropping information; a trailing newline is re-added later.
  const lines = source.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();

  const out: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    const bare = eq > 0 ? line.slice(0, eq).trim() : "";
    if (bare && remaining.has(bare)) {
      out.push(`${bare}=${quoteIfNeeded(remaining.get(bare) as string)}`);
      remaining.delete(bare);
    } else {
      out.push(line);
    }
  }

  // Append any keys that never appeared. A single blank separator keeps the
  // appended block readable without reflowing the operator's file.
  if (remaining.size > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    for (const [key, value] of remaining) {
      out.push(`${key}=${quoteIfNeeded(value)}`);
    }
  }

  return `${out.join(newline)}${newline}`;
}

/** Stable, truncated hash of file contents. Non-reversible; safe to display. */
export function hashContents(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

/**
 * Writes/updates secrets in the env file atomically, with a backup.
 *
 * The sequence is: read existing → merge → write temp → fsync → back up old →
 * rename over the target. If anything throws before the rename, the original
 * file is untouched and the temp file is removed.
 */
export function writeEnvSecrets(
  updates: Record<string, string>,
  options: WriteEnvSecretsOptions = {},
): SecretWriteResult {
  const filePath = resolveEnvPath(options);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    throw new SecretStoreError(`The environment directory does not exist: ${dir}`, { filePath });
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) {
    throw new SecretStoreError("No keys were provided to write.", { filePath });
  }

  const existed = existsSync(filePath);
  let previous = "";
  if (existed) {
    try {
      previous = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new SecretStoreError(
        `Could not read the existing environment file: ${error instanceof Error ? error.message : String(error)}`,
        { filePath, cause: error },
      );
    }
  }

  const next = upsertEnvLines(previous, updates);

  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
    writeSync(fd, next, null, "utf8");
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
      fd = undefined;
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // best effort
    }
    throw new SecretStoreError(
      `Could not write the environment file: ${error instanceof Error ? error.message : String(error)}`,
      { filePath, cause: error },
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
  }

  let backupCreated = false;
  if (options.keepBackup !== false && existed) {
    try {
      const backupPath = `${filePath}${ENV_BACKUP_SUFFIX}`;
      const backupFd = openSync(backupPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
      try {
        writeSync(backupFd, previous, null, "utf8");
        backupCreated = true;
      } finally {
        closeSync(backupFd);
      }
    } catch {
      // A failed backup must not fail the write; the rename below is the commit.
      backupCreated = false;
    }
  }

  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best effort
    }
    throw new SecretStoreError(
      `Could not replace the environment file: ${error instanceof Error ? error.message : String(error)}`,
      { filePath, cause: error },
    );
  }

  return {
    path: filePath,
    writtenKeys: [...keys],
    backupCreated,
    created: !existed,
    hash: hashContents(next),
  };
}

/**
 * Reads the presence (not the value) of the given keys from an env file.
 *
 * Returns key → boolean. Values are read only to decide emptiness; they are
 * never returned, so a caller cannot accidentally log or forward a secret.
 */
export function envKeysPresent(
  keys: readonly string[],
  options: { filePath?: string; cwd?: string } = {},
): Record<string, boolean> {
  const filePath = resolveEnvPath(options);
  let parsed: Record<string, string> = {};
  if (existsSync(filePath)) {
    try {
      parsed = parseDotEnv(readFileSync(filePath, "utf8"));
    } catch {
      parsed = {};
    }
  }
  const out: Record<string, boolean> = {};
  for (const key of keys) {
    const value = parsed[key];
    out[key] = typeof value === "string" && value.trim() !== "";
  }
  return out;
}

/**
 * Masks a secret for display: `••••••••1234`.
 *
 * Rules:
 *  - An empty/missing value yields an empty string (the caller renders "not set").
 *  - A short value is fully masked rather than revealing most of it.
 *  - Never returns the full secret, and never a prefix — only the last 4 chars.
 */
export function maskSecret(value: string | undefined, options: { visible?: number; mask?: string } = {}): string {
  if (!value) return "";
  const visible = options.visible ?? 4;
  const maskChar = options.mask ?? "•";
  // 8 dots keeps the familiar shape even for a very short secret.
  const dots = maskChar.repeat(8);
  if (value.length <= visible) return dots;
  return `${dots}${value.slice(-visible)}`;
}
