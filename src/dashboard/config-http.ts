/**
 * HTTP helper for the config API (Phase V2.1).
 *
 * Deliberately separate from `withService`: the config service does not need the
 * database, so the Settings page must work even when persistence is disabled.
 * `withService` (used by the task/agent routes) returns 503 when no database is
 * configured; that would wrongly block editing models and roles.
 */

import type { NextResponse } from "next/server";

import type { DashboardRuntime } from "./runtime.js";
import { getDashboardRuntime } from "./runtime.js";

export async function getConfigReady(): Promise<
  | { ok: true; runtime: DashboardRuntime }
  | { ok: false; response: NextResponse }
> {
  const runtime = await getDashboardRuntime();
  // The config service is always built, even on the unconfigured path.
  if (!runtime.configService) {
    const { jsonError } = await import("./http.js");
    return {
      ok: false,
      response: jsonError(
        "config_unavailable",
        "The configuration service is not available in this process.",
        { status: 503 },
      ),
    };
  }
  return { ok: true, runtime };
}
