/**
 * Config API (Phase V2.1).
 *
 * GET  -> the current validated config file + effective models/roles and the
 *         provenance of each model (config vs env). Safe: this file holds no
 *         secrets.
 * PATCH/PUT -> apply a partial update (models / catalog / roles / notes),
 *         validated against the Zod schema before the file is touched, then
 *         reload the in-memory config so the change takes effect without a
 *         restart.
 *
 * Mutations require DASHBOARD_ADMIN_TOKEN when one is configured
 * (`enforceAuthorization`), exactly like task creation.
 */

import {
  enforceAuthorization,
  handleError,
  jsonOk,
  readJsonBody,
} from "../../../src/dashboard/http.js";
import { ServiceError } from "../../../src/dashboard/service.js";
import { getDashboardRuntime } from "../../../src/dashboard/runtime.js";
import { getConfigReady } from "../../../src/dashboard/config-http.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ready = await getConfigReady();
    if (!ready.ok) return ready.response;
    return jsonOk(ready.runtime.configService.getConfig());
  } catch (error) {
    return handleError(error);
  }
}

async function applyUpdate(request: Request) {
  enforceAuthorization(request);

  const ready = await getConfigReady();
  if (!ready.ok) return ready.response;

  const body = await readJsonBody(request);

  // Models: accept an object of stage -> model, ignoring unknown stages rather
  // than letting a typo become a dead key (the schema is strict on the file, and
  // we build the patch explicitly here).
  const patch: {
    models?: { coder?: string; reviewer?: string; planner?: string };
    notes?: string;
  } = {};

  if (body.models !== undefined) {
    if (typeof body.models !== "object" || body.models === null || Array.isArray(body.models)) {
      throw new ServiceError('Field "models" must be an object.', {
        status: 422,
        code: "validation_error",
      });
    }
    const incoming = body.models as Record<string, unknown>;
    const models: { coder?: string; reviewer?: string; planner?: string } = {};
    for (const stage of ["coder", "reviewer", "planner"] as const) {
      const value = incoming[stage];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.trim() === "") {
        throw new ServiceError(`Field "models.${stage}" must be a non-empty string.`, {
          status: 422,
          code: "validation_error",
        });
      }
      models[stage] = value.trim();
    }
    patch.models = models;
  }

  if (typeof body.notes === "string") patch.notes = body.notes;

  const view = ready.runtime.configService.update(patch);

  // Re-read the file into memory so the next run uses the new models without a
  // server restart. Separate worker processes still need their own restart; the
  // view carries `path` so the UI can say so.
  ready.runtime.reloadConfig();

  return jsonOk(ready.runtime.configService.getConfig());
}

export async function PATCH(request: Request) {
  try {
    return await applyUpdate(request);
  } catch (error) {
    return handleError(error);
  }
}

export async function PUT(request: Request) {
  try {
    return await applyUpdate(request);
  } catch (error) {
    return handleError(error);
  }
}
