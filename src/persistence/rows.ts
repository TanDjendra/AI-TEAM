/**
 * Shared row-mapping helpers.
 *
 * The PostgreSQL driver returns snake_case rows with timestamps as `Date`
 * objects. Mapping happens once, here, instead of in every repository.
 */

import { redact } from "./redaction.js";

export type Row = Record<string, unknown>;

export function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

export function asNullableString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" ? value : String(value);
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function asNullableNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "t";
  return Boolean(value);
}

/** Timestamps arrive as Date from pg, but as string from some drivers/tests. */
export function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return new Date(0).toISOString();
}

export function asNullableIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return asIso(value);
}

/** jsonb comes back already parsed from pg; be tolerant anyway. */
export function asJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function asStringArray(value: unknown): string[] {
  const parsed = asJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

export function asStringRecord(value: unknown): Record<string, unknown> {
  const parsed = asJson<unknown>(value, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return redact(parsed) as Record<string, unknown>;
}

export function requireRow<T>(rows: T[], context: string): T {
  const [row] = rows;
  if (row === undefined) throw new Error(`${context}: expected a row but the query returned none`);
  return row;
}
