import { handleError, jsonOk, withService } from "../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/recovery — read-only stale scan.
 *
 * Reports which tasks look abandoned and the threshold in force. It never
 * mutates: applying recovery is an explicit POST per task.
 */
export async function GET() {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;
    return jsonOk(await ready.runtime.service.recoveryReport());
  } catch (error) {
    return handleError(error);
  }
}

export async function POST() {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;
    return jsonOk(await ready.runtime.service.applyRecovery());
  } catch (error) {
    return handleError(error);
  }
}
