/**
 * Config validation endpoint (Phase V2.1).
 *
 * POST a draft document (or a partial patch) and get back either the normalised
 * document or field-level issues. Nothing is written: this exists so the Settings
 * UI can validate live before the operator commits.
 *
 * No authorization is required because the endpoint is read-only and reflects no
 * secret — it only reports whether a proposed document would be accepted.
 */

import { handleError, jsonOk, readJsonBody } from "../../../../src/dashboard/http.js";
import { getConfigReady } from "../../../../src/dashboard/config-http.js";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const ready = await getConfigReady();
    if (!ready.ok) return ready.response;

    const body = await readJsonBody(request);
    // Accept either { document: {...} } or the document directly, so the raw
    // editor and the structured form can share one endpoint.
    const draft = "document" in body ? body.document : body;

    const result = ready.runtime.configService.validate(draft);
    if (result.ok) {
      return jsonOk({ valid: true, config: result.data });
    }
    return jsonOk({ valid: false, issues: result.issues });
  } catch (error) {
    return handleError(error);
  }
}
