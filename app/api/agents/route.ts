import { handleError, jsonOk, withService } from "../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;
    return jsonOk(await ready.runtime.service.listAgents());
  } catch (error) {
    return handleError(error);
  }
}
