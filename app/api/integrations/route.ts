import { handleError, jsonOk, withService } from "../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const candidates = await ready.runtime.service.listIntegrationCandidates();
    return jsonOk(candidates);
  } catch (error) {
    return handleError(error);
  }
}
