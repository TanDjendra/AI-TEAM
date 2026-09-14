import { handleError, jsonOk, withService } from "../../../../src/dashboard/http.js";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const { id } = await context.params;

    const workflow = await ready.runtime.service.getWorkflow(id);
    if (!workflow) {
      return jsonOk({ error: "Workflow not found" }, { status: 404 });
    }

    const nodes = await ready.runtime.service.getWorkflowNodes(id);
    const artifacts = await ready.runtime.service.getWorkflowArtifacts(id);

    return jsonOk({
      workflow,
      nodes,
      artifacts,
    });
  } catch (error) {
    return handleError(error);
  }
}
