import { isAbsolute, resolve, parse } from "node:path";
import { stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { ServiceError } from "../../../src/dashboard/service.js";
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
    const taskInput = {
      title: requireString(body, "title", { maxLength: 200 }),
      description: requireString(body, "description", { minLength: 1, maxLength: 20_000 }),
      ...(typeof body.autoGenerateId === "boolean"
        ? { autoGenerateId: body.autoGenerateId }
        : {}),
      ...(typeof body.autoPlan === "boolean"
        ? { autoPlan: body.autoPlan }
        : {}),
      ...(typeof body.externalId === "string" && body.externalId.trim()
        ? { externalId: body.externalId.trim().slice(0, 100) }
        : {}),
      ...(optionalStringArray(body, "acceptanceCriteria")
        ? { acceptanceCriteria: optionalStringArray(body, "acceptanceCriteria")! }
        : {}),
      ...(optionalPositiveInt(body, "maxReviewCycles", { min: 1, max: 20 }) === undefined
        ? {}
        : { maxReviewCycles: optionalPositiveInt(body, "maxReviewCycles", { min: 1, max: 20 })! }),
    };

    if (typeof body.workspace === "string" && body.workspace.trim()) {
      let ws = body.workspace.trim();
      // Normalize windows path separators for isAbsolute to work consistently if needed,
      // but Node's path.isAbsolute handles it on Windows.
      if (!isAbsolute(ws)) {
        throw new ServiceError("Project Workspace must be an absolute path.", { status: 422, code: "validation_error" });
      }
      ws = resolve(ws);
      // 1. Initial string-based security policy (prevents even probing forbidden roots)
      const normalizedWs = ws.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
      const parsedWs = parse(ws);
      const wsRoot = parsedWs.root.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
      
      const home = homedir().toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
      
      const forbiddenExact = [
        wsRoot, // Root drive (e.g. c:)
        wsRoot + '/windows',
        wsRoot + '/program files',
        wsRoot + '/program files (x86)',
        wsRoot + '/programdata',
        wsRoot + '/system volume information',
        home,
        home + '/.ssh',
        home + '/.aws',
        home + '/.gcp',
        home + '/.config'
      ];

      if (forbiddenExact.includes(normalizedWs)) {
        throw new ServiceError(`Project Workspace is forbidden by security policy: ${ws}`, { status: 422, code: "validation_error" });
      }

      // 2. File existence and directory check
      try {
        const s = await stat(ws);
        if (!s.isDirectory()) {
          throw new ServiceError("Project Workspace is not a directory.", { status: 422, code: "validation_error" });
        }
      } catch (e: any) {
        if (e.code === "ENOENT") {
          throw new ServiceError(`Project Workspace directory does not exist: ${ws}`, { status: 422, code: "validation_error" });
        }
        throw new ServiceError(`Project Workspace directory is not accessible: ${ws}`, { status: 422, code: "validation_error" });
      }

      // 3. Post-resolution symlink/junction escape check
      let realWs = "";
      try {
        realWs = await realpath(ws);
      } catch (e) {
        realWs = ws;
      }
      const normalizedRealWs = realWs.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');

      if (forbiddenExact.includes(normalizedRealWs)) {
        throw new ServiceError(`Project Workspace is forbidden by security policy: ${ws}`, { status: 422, code: "validation_error" });
      }

      (taskInput as any).workspace = realWs;
    }

    const task = await ready.runtime.service.createTask(taskInput as any);

    return jsonOk(task, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
