/**
 * Config roles collection (Phase V2.1).
 *
 * GET  -> the effective role list (built-ins + custom), each annotated with
 *         whether it is built-in / overridden / custom.
 * POST -> create or replace a role (built-in override or brand-new custom role),
 *         validated against the Zod schema before writing, then reload config.
 *
 * Mutations require DASHBOARD_ADMIN_TOKEN when one is configured.
 */

import {
  enforceAuthorization,
  handleError,
  jsonOk,
  readJsonBody,
} from "../../../../src/dashboard/http.js";
import { ServiceError } from "../../../../src/dashboard/service.js";
import { getConfigReady } from "../../../../src/dashboard/config-http.js";
import { ConfiguredRoleSchema } from "../../../../src/config/config-file.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ready = await getConfigReady();
    if (!ready.ok) return ready.response;
    return jsonOk(ready.runtime.configService.getConfig().roles);
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    enforceAuthorization(request);

    const ready = await getConfigReady();
    if (!ready.ok) return ready.response;

    const body = await readJsonBody(request);

    // Validate the role in isolation first so the error points at the role's own
    // fields rather than a generic "document invalid".
    const parsed = ConfiguredRoleSchema.safeParse(body);
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

    return jsonOk(ready.runtime.configService.getConfig().roles, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
