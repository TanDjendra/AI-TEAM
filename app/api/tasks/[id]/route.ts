import { handleError, jsonError, jsonOk, withService } from "../../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const { id } = await context.params;
    const detail = await ready.runtime.service.getTaskDetail(id);
    if (!detail) return jsonError("not_found", `No task with id or external id "${id}"`, { status: 404 });

    return jsonOk(detail);
  } catch (error) {
    return handleError(error);
  }
}
