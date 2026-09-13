import { handleError, jsonOk, withService } from "../../../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const { id } = await context.params;
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? "500");
    const activity = await ready.runtime.service.listActivity({
      taskId: id,
      limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 500,
    });

    return jsonOk(activity);
  } catch (error) {
    return handleError(error);
  }
}
