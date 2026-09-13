import { handleError, jsonOk, withService } from "../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const status = await ready.runtime.service.systemStatus();
    // Real transport names, from both buses that make up the fan-out: the
    // persistence bus bridges the journal to the hub, and the hub's own bus
    // carries in-process events. Reporting a union avoids the misleading empty
    // list an operator would otherwise see while the stream is working fine.
    const transports = [
      ...(ready.runtime.persistence?.bus.transportNames() ?? []),
      ...ready.runtime.hub.transports(),
    ];

    return jsonOk({
      ...status,
      realtime: {
        connections: ready.runtime.hub.connectionCount(),
        transports: [...new Set(transports)],
        stream: "/api/events",
        source: "database",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
