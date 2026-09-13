import { handleError, jsonOk, withService } from "../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const isDbReady = await ready.runtime.persistence?.db.isReady();
    if (!isDbReady) {
      return new Response(JSON.stringify({ status: "unavailable", reason: "database not ready" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    return jsonOk({ status: "ok" });
  } catch (error) {
    return handleError(error);
  }
}
