import { withService, jsonOk, handleError } from "../../../dashboard/http.js";

export async function POST(request: Request) {
  const result = await withService();
  if (!result.ok) return result.response;
  
  try {
    const report = await result.runtime.service.applyRecovery();
    return jsonOk(report);
  } catch (error) {
    result.runtime.logger.error("api.recovery.error", {
      error: error instanceof Error ? error.message : String(error)
    });
    return handleError(error);
  }
}

