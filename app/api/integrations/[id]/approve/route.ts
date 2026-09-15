import { handleError, jsonOk, withService } from "../../../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    // Use await for dynamic route params in Next.js 15
    const { id } = await params;
    await ready.runtime.service.approveIntegration(id);

    return jsonOk({ success: true, message: "Integration approved" });
  } catch (error) {
    return handleError(error);
  }
}
