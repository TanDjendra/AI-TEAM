/**
 * Task sub-resource: reads (GET) and control actions (POST).
 *
 * One route segment handles both so there is no ambiguity between a static
 * control path and a dynamic resource path. Reads return a slice of the task
 * detail; actions go through the service, which records every action as a real
 * event.
 */

import {
  enforceAuthorization,
  handleError,
  jsonError,
  jsonOk,
  readJsonBody,
  withService,
} from "../../../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

const READ_SLICES = ["runs", "reviews", "tool-calls", "files", "tests", "activity", "capabilities"] as const;
const ACTIONS = ["start", "pause", "resume", "cancel", "retry", "approve", "recover"] as const;

type ReadSlice = (typeof READ_SLICES)[number];
type ControlAction = (typeof ACTIONS)[number];

export async function GET(_request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const { id, action } = await context.params;
    if (!(READ_SLICES as readonly string[]).includes(action)) {
      return jsonError("not_found", `Unknown resource "${action}"`, {
        status: 404,
        details: { allowed: READ_SLICES },
      });
    }

    if (action === "capabilities") {
      // Capabilities are computed, not stored: they are the control table's
      // answer for this task's current status.
      const capabilities = await ready.runtime.service.getCapabilities(id);
      if (!capabilities) return jsonError("not_found", `No task with id or external id "${id}"`, { status: 404 });
      return jsonOk(capabilities);
    }

    const detail = await ready.runtime.service.getTaskDetail(id);
    if (!detail) return jsonError("not_found", `No task with id or external id "${id}"`, { status: 404 });

    // `capabilities` was handled above (it is computed, not stored).
    const slice = action as Exclude<ReadSlice, "capabilities">;
    return jsonOk(detail[slice === "tool-calls" ? "toolCalls" : slice]);
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  try {
    enforceAuthorization(request);

    const ready = await withService();
    if (!ready.ok) return ready.response;

    const { id, action } = await context.params;
    if (!(ACTIONS as readonly string[]).includes(action)) {
      return jsonError("not_found", `Unknown action "${action}"`, {
        status: 404,
        details: { allowed: ACTIONS },
      });
    }

    const body = await readJsonBody(request);
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
    const service = ready.runtime.service;

    const outcome = await (async () => {
      const selected: ControlAction = action as ControlAction;
      switch (selected) {
        case "start":
          return service.startTask(id);
        case "pause":
          return service.pauseTask(id, reason);
        case "resume":
          return service.resumeTask(id, reason);
        case "cancel":
          return service.cancelTask(id, reason);
        case "retry":
          return service.retryTask(id, reason);
        case "approve":
          return service.approveTask(id, reason);
        case "recover":
          return service.recoverTask(id);
      }
    })();

    ready.runtime.logger.info("control.action", {
      action,
      taskId: id,
      ok: outcome.ok,
      eventId: outcome.eventId,
    });

    return jsonOk(outcome);
  } catch (error) {
    return handleError(error);
  }
}
