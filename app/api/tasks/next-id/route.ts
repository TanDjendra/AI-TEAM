import { handleError, jsonOk, withService } from "../../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const nextId = await ready.runtime.service.predictNextExternalId();
    return jsonOk({ nextId });
  } catch (error) {
    return handleError(error);
  }
}
