/**
 * Safe payload handling for everything that reaches the database.
 *
 * Two separate concerns, deliberately kept apart:
 *
 *   1. Secret redaction — API keys, bearer tokens, passwords, cookies.
 *   2. Size bounding — a command output can be megabytes; the database should
 *      keep a useful summary, not the whole log.
 *
 * Both are enforced at the persistence boundary, so no caller can accidentally
 * store a credential or an unbounded blob.
 */

import { scrubSecrets } from "../domain/errors.js";

/** Keys whose values are never stored, wherever they appear in a structure. */
const SECRET_KEY_PATTERN =
  /(^|[_.-])(api[_-]?key|apikey|authorization|auth|token|secret|password|passwd|cookie|credential|private[_-]?key)([_.-]|$)/i;

/** Keys whose values are replaced by a length marker instead of being dropped. */
const PAYLOAD_KEY_PATTERN = /^(raw|rawPrompt|rawContent|prompt|fullContent|content)$/i;

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ARRAY = 100;

export interface RedactionOptions {
  /** Maximum string length before truncation. */
  maxStringLength?: number;
  /** Maximum nesting depth; deeper structures become "[depth-limit]". */
  maxDepth?: number;
  maxArrayLength?: number;
}

export const DEFAULT_MAX_STRING = 4_000;
export const OUTPUT_SUMMARY_MAX = 2_000;
export const SUMMARY_MAX = 500;

/**
 * Deep-copies a value, removing secrets and bounding size.
 * Never throws: a circular or exotic value is replaced by a description.
 */
export function redact<T>(value: T, options: RedactionOptions = {}): unknown {
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY;

  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) return input;

    if (typeof input === "string") {
      const scrubbed = scrubSecrets(input);
      return truncateString(scrubbed, maxStringLength);
    }
    if (typeof input === "number" || typeof input === "boolean") return input;
    if (typeof input === "bigint") return input.toString();
    if (typeof input === "function") return "[Function]";
    if (typeof input === "symbol") return input.toString();

    if (depth >= maxDepth) return "[depth-limit]";

    if (input instanceof Date) return input.toISOString();
    if (input instanceof Error) {
      const error = input as Error & { kind?: string; status?: number };
      return {
        name: error.name,
        message: truncateString(scrubSecrets(error.message), maxStringLength),
        ...(error.kind ? { kind: error.kind } : {}),
        ...(typeof error.status === "number" ? { status: error.status } : {}),
      };
    }

    if (Array.isArray(input)) {
      const items = input.slice(0, maxArrayLength).map((entry) => walk(entry, depth + 1));
      if (input.length > maxArrayLength) {
        items.push(`[+${input.length - maxArrayLength} more]`);
      }
      return items;
    }

    if (typeof input === "object") {
      if (seen.has(input as object)) return "[circular]";
      seen.add(input as object);

      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
        if (SECRET_KEY_PATTERN.test(key)) {
          out[key] = "[REDACTED]";
          continue;
        }
        if (PAYLOAD_KEY_PATTERN.test(key) && typeof entry === "string") {
          // Keep the shape without storing the payload body itself.
          out[key] = `[omitted ${entry.length} chars]`;
          continue;
        }
        out[key] = walk(entry, depth + 1);
      }
      return out;
    }

    return String(input);
  };

  return walk(value, 0);
}

/** Convenience: redaction as a JSON string, ready for a jsonb column. */
export function redactToJson(value: unknown, options: RedactionOptions = {}): string {
  return JSON.stringify(redact(value, options));
}

/** Redacts a tool-call argument object and reports whether anything changed. */
export function redactArguments(args: Record<string, unknown>): {
  value: Record<string, unknown>;
  redacted: boolean;
} {
  const before = JSON.stringify(args);
  const value = redact(args, { maxStringLength: 2_000 }) as Record<string, unknown>;
  return { value, redacted: JSON.stringify(value) !== before };
}

/**
 * Builds a bounded, redacted one-line summary of command/tool output.
 * Keeps the tail as well as the head, because failures show up at the end.
 */
export function summarizeOutput(output: string, max = OUTPUT_SUMMARY_MAX): string {
  const scrubbed = scrubSecrets(output ?? "").replace(/\r\n/g, "\n").trim();
  if (scrubbed.length <= max) return scrubbed;

  const headLength = Math.floor(max * 0.6);
  const tailLength = max - headLength - 40;
  return (
    scrubbed.slice(0, headLength) +
    `\n…[+${scrubbed.length - headLength - tailLength} chars omitted]…\n` +
    scrubbed.slice(-tailLength)
  );
}

export function summarize(text: string, max = SUMMARY_MAX): string {
  const scrubbed = scrubSecrets(text ?? "").replace(/\s+/g, " ").trim();
  return scrubbed.length <= max ? scrubbed : `${scrubbed.slice(0, max)}…`;
}

function truncateString(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[+${value.length - max} chars]`;
}
