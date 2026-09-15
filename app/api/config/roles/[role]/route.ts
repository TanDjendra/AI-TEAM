/**
 * A single config role (Phase V2.1).
 *
 * GET    -> one effective role view, or 404.
 * PUT    -> create/replace the role named in the path (body supplies the rest;
 *           the path segment is authoritative for `role`).
 * DELETE -> remove a custom role. Built-in roles cannot be deleted; override them
 *           instead so the pipeline always has a profile.
 *
 * Mutations require DASHBOARD_ADMIN_TOKEN when one is configured.
 */

import {
  enforceAuthorization,
  handleError,
  jsonOk,
  readJsonBody,
} from "../../../../../src/dashboard/http.js";
import { ServiceError } from "../../../../../src/dashboard/service.js";
import { getConfigReady } from "../../../../../src/dashboard/config-http.js";
import { ConfiguredRoleSchema } from "../../../../../src/config/config-file.js";

export const dynamic = "force-dynamic";

function readRoleParam(params: { role?: string }): string {
  const role = params.role?.trim();
  if (!role) {
    throw new ServiceError("A role name is required in the path.", {
      status: 422,
      code: "validation_error",
    });
  }
  return role;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ role: string }> },
) {
  try {
    const ready = await getConfigReady();
    if (!ready.ok) return ready.response;

    const { role } = await params;
    const view = ready.runtime.configService.getRole(readRoleParam({ role }));
    if (!view) {
      return handleError(
        new ServiceError(`No role named "${role}".`, { status: 404, code: "role_not_found" }),
      );
    }
    return jsonOk(view);
  } catch (error) {
    return handleError(error);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ role: string }> },
) {
  try {
    enforceAuthorization(request);

    const ready = await getConfigReady();
    if (!ready.ok) return ready.response;

    const { role } = await params;
    const roleName = readRoleParam({ role });
    const body = await readJsonBody(request);

    // The path wins for the role name; the body supplies the definition.
    const parsed = ConfiguredRoleSchema.safeParse({ ...body, role: roleName });
    if (!parsed.success) {
      throw new ServiceError(
        `The role is not valid: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
          .join("; ")}`,
        { status: 422, code: "validation_error" },
      );
    }

    ready.runtime.configService.upsertRole(parsed.data);
    ready.runtime.reloadConfig();

    return jsonOk(ready.runtime.configService.getConfig().roles);
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ role: string }> },
) {
  try {
    enforceAuthorization(request);

    const ready = await getConfigReady();
    if (!ready.ok) return ready.response;

    const { role } = await params;
    ready.runtime.configService.deleteRole(readRoleParam({ role }));
    ready.runtime.reloadConfig();

    return jsonOk(ready.runtime.configService.getConfig().roles);
  } catch (error) {
    return handleError(error);
  }
}
