/**
 * Structured logging. One JSON object per line (or a compact text rendering),
 * with secret scrubbing applied to every field.
 *
 * Contract: log lines go to stderr, machine-readable results go to stdout. That
 * keeps `npm run task -- --json` pipeable.
 */

import { scrubSecrets } from "./errors.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFormat = "json" | "text";

export type LogFieldValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Error
  | readonly LogFieldValue[]
  | { readonly [key: string]: LogFieldValue };

export interface LogRecord {
  time: string;
  level: LogLevel;
  event: string;
  [key: string]: LogFieldValue | string;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  /** Destination for rendered lines. Defaults to process.stderr. */
  sink?: (line: string) => void;
  /** Extra fields merged into every record (e.g. { taskId, runId }). */
  base?: Record<string, LogFieldValue>;
  /** Injectable clock, so tests get deterministic timestamps. */
  now?: () => Date;
}

export interface Logger {
  readonly level: LogLevel;
  child(fields: Record<string, LogFieldValue>): Logger;
  debug(event: string, fields?: Record<string, LogFieldValue>): void;
  info(event: string, fields?: Record<string, LogFieldValue>): void;
  warn(event: string, fields?: Record<string, LogFieldValue>): void;
  error(event: string, fields?: Record<string, LogFieldValue>): void;
  log(level: LogLevel, event: string, fields?: Record<string, LogFieldValue>): void;
  /** Test seam: every record emitted by this logger and its children. */
  records(): readonly LogRecord[];
}

/**
 * A key is sensitive when it IS (or clearly names) a credential. The anchors stop
 * over-redaction of diagnostic fields such as "apiKeySource" that merely contain
 * the word "key".
 */
const SENSITIVE_KEY =
  /(^|[_.-])(api[_-]?key|apikey|authorization|auth|token|secret|password|passwd|cookie|credential)([_.-]|$)/i;
/** Payload keys we never want in logs even if not credential-shaped. */
const DENIED_KEYS: ReadonlySet<string> = new Set(["rawPrompt", "prompt", "apiKey", "rawContent"]);

function scrub(text: string, max: number): string {
  const clean = scrubSecrets(text);
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function sanitise(value: unknown, depth = 0): LogFieldValue {
  if (value === null) return null;
  if (value === undefined) return undefined;

  switch (typeof value) {
    case "string":
      return scrub(value, 4000);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
      return "[Function]";
    case "symbol":
      return value.toString();
    default:
      break;
  }

  if (depth >= 6) return "[depth-limit]";

  if (value instanceof Error) {
    const error = value as Error & { kind?: string; status?: number };
    return {
      name: error.name,
      message: scrub(error.message, 600),
      ...(error.kind ? { kind: error.kind } : {}),
      ...(typeof error.status === "number" ? { status: error.status } : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitise(item, depth + 1));
  }

  const out: Record<string, LogFieldValue> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitise(raw, depth + 1);
  }
  return out;
}

interface LoggerState {
  level: LogLevel;
  format: LogFormat;
  sink: (line: string) => void;
  now: () => Date;
  base: Record<string, LogFieldValue>;
  buffer: LogRecord[];
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const state: LoggerState = {
    level: options.level ?? "info",
    format: options.format ?? "text",
    sink: options.sink ?? ((line: string) => process.stderr.write(`${line}\n`)),
    now: options.now ?? (() => new Date()),
    base: options.base ?? {},
    buffer: [],
  };
  return build(state, {});
}

function build(state: LoggerState, localBase: Record<string, LogFieldValue>): Logger {
  const emit = (
    recordLevel: LogLevel,
    event: string,
    fields: Record<string, LogFieldValue> = {},
  ): void => {
    if (LEVEL_RANK[recordLevel] < LEVEL_RANK[state.level]) return;

    const merged: Record<string, LogFieldValue> = { ...state.base, ...localBase };
    for (const [key, value] of Object.entries(fields)) {
      merged[key] =
        DENIED_KEYS.has(key) || SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitise(value);
    }

    const record: LogRecord = {
      time: state.now().toISOString(),
      level: recordLevel,
      event,
      ...merged,
    };

    state.buffer.push(record);
    state.sink(render(record, state.format));
  };

  return {
    level: state.level,
    child: (fields) => build(state, { ...localBase, ...fields }),
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    log: (recordLevel, event, fields) => emit(recordLevel, event, fields),
    records: () => state.buffer.slice(),
  };
}

function render(record: LogRecord, format: LogFormat): string {
  if (format === "json") return JSON.stringify(record);

  const { time, level, event, ...rest } = record;
  const suffix = Object.entries(rest)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${formatValue(value as LogFieldValue)}`)
    .join(" ");
  return `${time} ${level.toUpperCase().padEnd(5)} ${event}${suffix ? ` ${suffix}` : ""}`;
}

function formatValue(value: LogFieldValue): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") {
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** A logger that discards everything — handy in tests that don't assert logs. */
export function silentLogger(): Logger {
  return createLogger({ level: "error", sink: () => {} });
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
