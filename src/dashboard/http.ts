/**
 * HTTP helpers shared by every API route.
 *
 * Handlers stay thin: they declare intent, this module owns the response shape,
 * the error mapping, the no-cache policy and the "database not configured"
 * contract. No handler builds a Response by hand.
 */

import { NextResponse } from "next/server";

import { ServiceError } from "./service.js";
import type { DashboardRuntime } from "./runtime.js";
import { getDashboardRuntime } from "./runtime.js";

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

/** Live data must never be cached by a CDN or the browser. */
const NO_STORE = {
  "cache-control": "no-store, max-age=0, must-revalidate",
} as const;

export function jsonOk<T>(data: T, init?: { status?: number; headers?: Record<string, string> }) {
  return NextResponse.json<ApiSuccess<T>>(
    { ok: true, data },
    { status: init?.status ?? 200, headers: { ...NO_STORE, ...(init?.headers ?? {}) } },
  );
}

export function jsonError(
  code: string,
  message: string,
  init?: { status?: number; details?: unknown },
) {
  return NextResponse.json<ApiFailure>(
    { ok: false, error: { code, message, ...(init?.details === undefined ? {} : { details: init.details }) } },
    { status: init?.status ?? 400, headers: NO_STORE },
  );
}

export function jsonNotConfigured(runtime: DashboardRuntime) {
  return jsonError(
    "database_not_configured",
    "DATABASE_URL is not set. The dashboard reads real data from PostgreSQL; set DATABASE_URL to enable it.",
    { status: 503, details: runtime.error ? { reason: runtime.error } : undefined },
  );
}

/**
 * Resolves the runtime and guarantees persistence, or returns the error response
 * the caller should return.
 */
export async function withService(): Promise<
  | { ok: true; runtime: DashboardRuntime & { service: NonNullable<DashboardRuntime["service"]> } }
  | { ok: false; response: NextResponse }
> {
  const runtime = await getDashboardRuntime();
  if (!runtime.configured || !runtime.service) {
    return { ok: false, response: jsonNotConfigured(runtime) };
  }
  return {
    ok: true,
    runtime: runtime as DashboardRuntime & { service: NonNullable<DashboardRuntime["service"]> },
  };
}

export function handleError(error: unknown) {
  if (error instanceof Error && error.name === "ServiceError") {
    const err = error as ServiceError;
    return jsonError(err.code, err.message, { status: err.status });
  }
  const message = error instanceof Error ? error.message : String(error);
  // Never echo a stack trace or a raw driver message to the browser.
  return jsonError("internal_error", "The request could not be completed.", {
    status: 500,
    details: { reason: message.slice(0, 300) },
  });
}

/** Parses and validates a JSON body without trusting its shape. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
  options: { maxLength?: number; minLength?: number } = {},
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ServiceError(`Field "${field}" is required and must be a non-empty string`, {
      status: 422,
      code: "validation_error",
    });
  }
  const trimmed = value.trim();
  if (options.minLength !== undefined && trimmed.length < options.minLength) {
    throw new ServiceError(`Field "${field}" must be at least ${options.minLength} characters`, {
      status: 422,
      code: "validation_error",
    });
  }
  if (options.maxLength !== undefined && trimmed.length > options.maxLength) {
    throw new ServiceError(`Field "${field}" must be at most ${options.maxLength} characters`, {
      status: 422,
      code: "validation_error",
    });
  }
  return trimmed;
}

export function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ServiceError(`Field "${field}" must be an array of strings`, {
      status: 422,
      code: "validation_error",
    });
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function optionalPositiveInt(
  body: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ServiceError(`Field "${field}" must be an integer`, {
      status: 422,
      code: "validation_error",
    });
  }
  const min = options.min ?? 1;
  const max = options.max ?? 20;
  if (parsed < min || parsed > max) {
    throw new ServiceError(`Field "${field}" must be between ${min} and ${max}`, {
      status: 422,
      code: "validation_error",
    });
  }
  return parsed;
}

export function enforceAuthorization(request: Request) {
  const adminToken = process.env.DASHBOARD_ADMIN_TOKEN;
  if (!adminToken) return; // If no token is configured, allow anonymous access

  const authHeader = request.headers.get("authorization");
  if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
    throw new ServiceError("Unauthorized: Invalid or missing DASHBOARD_ADMIN_TOKEN", {
      status: 401,
      code: "unauthorized",
    });
  }
}

export { NO_STORE };
