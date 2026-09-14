import { handleError, jsonOk, withService } from "../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");

    return jsonOk(await ready.runtime.service.listWorkflows({ status: statusParam ?? undefined }));
  } catch (error) {
    return handleError(error);
  }
}
