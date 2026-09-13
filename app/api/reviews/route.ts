import { handleError, jsonOk, withService } from "../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const url = new URL(request.url);
    const taskId = url.searchParams.get("taskId") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "100");

    return jsonOk(
      await ready.runtime.service.listReviews({
        ...(taskId ? { taskId } : {}),
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100,
      }),
    );
  } catch (error) {
    return handleError(error);
  }
}
