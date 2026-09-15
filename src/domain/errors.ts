/**
 * Normalised error taxonomy. Nothing in the codebase should leak a raw
 * `fetch`/`AbortError`/socket error to a caller or a log line.
 */

export type ErrorKind =
  | "timeout"
  | "rate-limit"
  | "server-error"
  | "authentication"
  | "validation"
  | "not-found"
  | "network"
  | "parse"
  | "unknown";

/** Which kinds are worth retrying automatically. */
const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  "timeout",
  "rate-limit",
  "server-error",
  "network",
]);

export class RouterError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  /** Response body excerpt, already truncated and secret-scrubbed. */
  readonly detail?: string;

  constructor(
    message: string,
    init: {
      kind: ErrorKind;
      status?: number;
      retryable?: boolean;
      requestId?: string;
      detail?: string;
      cause?: unknown;
    },
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "RouterError";
    this.kind = init.kind;
    this.status = init.status;
    this.retryable = init.retryable ?? RETRYABLE.has(init.kind);
    this.requestId = init.requestId;
    this.detail = init.detail;
  }
}

export function isRouterError(value: unknown): value is RouterError {
  return value instanceof RouterError;
}

const REDACT_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|sk|gsk|9r|grip)[-_.A-Za-z0-9]{15,}\b/gi,
  /("?(?:api[_-]?key|authorization|token|secret|password)"?\s*[:=]\s*)"?[^"\s,}\]]+"?/gi,
];

function getEnvSecrets(): string[] {
  const secrets = [];
  if (process.env.ROUTER_API_KEY && process.env.ROUTER_API_KEY.length > 5) {
    secrets.push(process.env.ROUTER_API_KEY);
  }
  // Add other secrets here if they exist
  return secrets;
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** Removes anything that looks like a credential from arbitrary text. */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const secret of getEnvSecrets()) {
    if (out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, (match, prefix) => {
      // If it has a prefix like "api_key=", keep the prefix but redact the value
      if (prefix) return `${prefix}[REDACTED]`;
      return "[REDACTED]";
    });
  }
  return out;
}

export function truncate(text: string, max = 600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

export function classifyHttpStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "not-found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server-error";
  if (status >= 400) return "validation";
  return "unknown";
}

export function classifyThrown(value: unknown): ErrorKind {
  const name = value instanceof Error ? value.name : "";
  const code = (value as { code?: string } | null)?.code ?? "";
  if (name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return "timeout";
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EPIPE"
  ) {
    return "network";
  }
  return "unknown";
}

/** Normalises any thrown value into a RouterError with a human message. */
export function toRouterError(value: unknown, context: { url?: string } = {}): RouterError {
  if (isRouterError(value)) return value;

  const kind = classifyThrown(value);
  const raw = value instanceof Error ? value.message : String(value);
  const where = context.url ? ` (${context.url})` : "";

  const friendly =
    kind === "timeout"
      ? `9Router request timed out${where}`
      : kind === "network"
        ? `9Router is unreachable${where} — is the local router running?`
        : `9Router request failed${where}: ${raw}`;

  return new RouterError(friendly, { kind, cause: value, detail: scrubSecrets(truncate(raw)) });
}

// ---------------------------------------------------------------------------
// Setup / connection diagnostics (Phase 1)
// ---------------------------------------------------------------------------
//
// The setup wizard and the product CLI must tell an operator *what is wrong*
// without showing a stack trace. These labels are a small, stable vocabulary
// layered ON TOP of the existing `ErrorKind` taxonomy — they do not replace it.
// A single mapper keeps every caller consistent, so a raw fetch/socket error is
// never surfaced verbatim.

export type SetupFailureLabel =
  | "INVALID_URL"
  | "ROUTER_UNREACHABLE"
  | "INVALID_API_KEY"
  | "TIMEOUT"
  | "SERVER_ERROR"
  | "MODEL_NOT_FOUND"
  | "UNKNOWN";

/** True when a string is a syntactically valid http(s) URL. */
export function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Maps an existing `ErrorKind` onto a user-facing setup label.
 *
 * Kept separate from `classifyHttpStatus` so the transport taxonomy stays
 * untouched; this is presentation, not classification.
 */
export function setupLabelForKind(kind: ErrorKind): SetupFailureLabel {
  switch (kind) {
    case "authentication":
      return "INVALID_API_KEY";
    case "network":
      return "ROUTER_UNREACHABLE";
    case "timeout":
      return "TIMEOUT";
    case "server-error":
    case "rate-limit":
      return "SERVER_ERROR";
    case "not-found":
      return "MODEL_NOT_FOUND";
    case "validation":
      // A 4xx that is not auth/404 is almost always a malformed request, which
      // in a connection test means the URL or the request shape is wrong.
      return "INVALID_URL";
    default:
      return "UNKNOWN";
  }
}

/**
 * Short, operator-readable explanation for a label. No stack traces, no URLs
 * containing credentials, no raw driver text.
 */
export function describeSetupLabel(label: SetupFailureLabel): string {
  switch (label) {
    case "INVALID_URL":
      return "The router URL is not a valid http(s) address. It should include the /v1 suffix.";
    case "ROUTER_UNREACHABLE":
      return "The router could not be reached. Check that 9Router is running and the URL is correct.";
    case "INVALID_API_KEY":
      return "The router rejected the API key. Check ROUTER_API_KEY.";
    case "TIMEOUT":
      return "The router did not respond in time. It may be slow or unreachable.";
    case "SERVER_ERROR":
      return "The router returned a server error. Try again shortly.";
    case "MODEL_NOT_FOUND":
      return "The router does not serve the requested model.";
    default:
      return "The connection test failed for an unknown reason.";
  }
}

/**
 * Classifies any thrown value for the setup flow.
 *
 * Precedence: an explicit, already-classified `RouterError` wins; otherwise the
 * thrown value is classified; finally a syntactically invalid `baseUrl` is
 * reported as `INVALID_URL` rather than a generic network failure, because the
 * two need very different operator responses.
 */
export function classifySetupFailure(
  value: unknown,
  context: { baseUrl?: string } = {},
): { label: SetupFailureLabel; message: string } {
  if (context.baseUrl && !isValidHttpUrl(context.baseUrl)) {
    return {
      label: "INVALID_URL",
      message: describeSetupLabel("INVALID_URL"),
    };
  }

  if (value instanceof RouterError) {
    const label = setupLabelForKind(value.kind);
    return { label, message: describeSetupLabel(label) };
  }

  const label = setupLabelForKind(classifyThrown(value));
  return { label, message: describeSetupLabel(label) };
}
