import { handleError, jsonOk, readJsonBody, withService } from "../../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const { id } = await params;
    const body = await readJsonBody(request);
    const reason = typeof body.reason === "string" ? body.reason : undefined;

    await ready.runtime.service.rejectIntegration(id, reason);

    return jsonOk({ success: true, message: "Integration rejected" });
  } catch (error) {
    return handleError(error);
  }
}
