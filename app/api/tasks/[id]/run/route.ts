/**
 * POST /api/tasks/:id/run — start the task now.
 *
 * Kept as a thin alias of `start` for callers that used it before PHASE 6 (the
 * live realtime demo script, in particular). There is no second execution path:
 * all it does is delegate to the control service, so the double-start guard, the
 * audit trail and the worker are identical to `POST /api/tasks/:id/start`.
 */

import { withService, handleError, jsonOk } from "../../../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const { id } = await context.params;
    return jsonOk(await ready.runtime.service.startTask(id));
  } catch (error) {
    return handleError(error);
  }
}
