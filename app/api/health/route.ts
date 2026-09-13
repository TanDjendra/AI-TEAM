import { handleError, jsonOk, withService } from "../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const status = await ready.runtime.service.systemStatus();
    const activeWorkers = status.workers.filter(w => !w.stale);

    return jsonOk({ 
      ok: true, 
      databaseReady: status.database.ready,
      activeWorkers: activeWorkers.length
    });
  } catch (error) {
    return handleError(error);
  }
}
