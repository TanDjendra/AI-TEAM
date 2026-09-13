import { handleError, jsonOk, withService } from "../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const limit = Number(new URL(request.url).searchParams.get("limit") ?? "200");
    return jsonOk(
      await ready.runtime.service.listActivity({
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200,
      }),
    );
  } catch (error) {
    return handleError(error);
  }
}
