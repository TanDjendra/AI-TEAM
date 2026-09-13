import {
  enforceAuthorization,
  handleError,
  jsonOk,
  optionalPositiveInt,
  optionalStringArray,
  readJsonBody,
  requireString,
  withService,
} from "../../../src/dashboard/http.js";
import type { TaskStatus } from "../../../src/events/types.js";

export const dynamic = "force-dynamic";

const KNOWN_STATUSES: readonly TaskStatus[] = [
  "PENDING",
  "CODING",
  "TESTING",
  "REVIEW",
  "REJECTED",
  "FIXING",
  "APPROVED",
  "DONE",
  "NEEDS_HUMAN",
  "PAUSED",
  "CANCELLED",
];

export async function GET(request: Request) {
  try {
    const ready = await withService();
    if (!ready.ok) return ready.response;

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status = statusParam
      ? statusParam
          .split(",")
          .map((entry) => entry.trim().toUpperCase())
          .filter((entry): entry is TaskStatus => (KNOWN_STATUSES as readonly string[]).includes(entry))
      : undefined;

    const limitParam = Number(url.searchParams.get("limit") ?? "200");
    const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 200;

    return jsonOk(await ready.runtime.service.listTasks({ status, limit }));
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    enforceAuthorization(request);

    const ready = await withService();
    if (!ready.ok) return ready.response;

    const body = await readJsonBody(request);
    const task = await ready.runtime.service.createTask({
      title: requireString(body, "title", { maxLength: 200 }),
      description: requireString(body, "description", { minLength: 1, maxLength: 20_000 }),
      ...(typeof body.externalId === "string" && body.externalId.trim()
        ? { externalId: body.externalId.trim().slice(0, 100) }
        : {}),
      ...(optionalStringArray(body, "acceptanceCriteria")
        ? { acceptanceCriteria: optionalStringArray(body, "acceptanceCriteria")! }
        : {}),
      ...(optionalPositiveInt(body, "maxReviewCycles", { min: 1, max: 20 }) === undefined
        ? {}
        : { maxReviewCycles: optionalPositiveInt(body, "maxReviewCycles", { min: 1, max: 20 })! }),
    });

    return jsonOk(task, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
