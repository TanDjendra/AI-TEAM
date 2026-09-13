import { handleError, jsonError, jsonOk, withService } from "../../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const { id } = await context.params;
    const agent = await ready.runtime.service.getAgent(id);
    if (!agent) return jsonError("not_found", `No agent with id or key "${id}"`, { status: 404 });

    return jsonOk(agent);
  } catch (error) {
    return handleError(error);
  }
}
