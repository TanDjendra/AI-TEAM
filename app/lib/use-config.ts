"use client";

/**
 * Client hook for the V2.1 config API.
 *
 * Wraps the tiny `apiGet`/`apiPost` helpers with the shape the Settings page
 * needs: the loaded config view, a dirty-draft for the models form, a save that
 * only reports success after the server confirms, and a "reload from disk" path.
 *
 * Design note: mutations are NEVER optimistic. `save` returns the server's
 * verdict, and the UI keeps the operator's edits on screen if the write is
 * rejected — so a failed save never looks like a successful one.
 */

import * as React from "react";

import { apiGet } from "./use-api.js";

export interface ConfigFileMeta {
  path: string;
  exists: boolean;
  mtimeMs?: number;
  sizeBytes?: number;
  hash?: string;
}

export interface ConfigConfig {
  version: 1;
  models: { coder?: string; reviewer?: string; planner?: string };
  catalog: Array<{
    id: string;
    providerId?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsToolCalling?: boolean;
    supportsVision?: boolean;
  }>;
  roles: Array<{
    role: string;
    defaultModelId: string;
    systemPromptTemplate: string;
    allowedTools?: string[];
  }>;
  notes?: string;
}

export interface ConfigRoleView {
  role: string;
  defaultModelId: string;
  systemPromptTemplate: string;
  allowedTools: string[];
  builtIn: boolean;
  overridden: boolean;
  custom: boolean;
}

export interface ConfigViewModel {
  path: string;
  file: ConfigFileMeta;
  config: ConfigConfig;
  models: { coder: string; reviewer: string; planner: string };
  catalog: Array<{ id: string; providerId: string; contextWindow: number; supportsToolCalling: boolean }>;
  roles: ConfigRoleView[];
  /** Real tool names from the agent registry, for the tool-policy editor. */
  availableTools: string[];
  sources: { coder: "config" | "env"; reviewer: "config" | "env"; planner: "config" | "env" };
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface ConfigState {
  data: ConfigViewModel | undefined;
  error: string | undefined;
  loading: boolean;
  refresh: () => void;
}

/** Reads the current config view, refreshing on demand. */
export function useConfig(): ConfigState {
  const [data, setData] = React.useState<ConfigViewModel | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading((current) => (data === undefined ? true : current));

    apiGet<ConfigViewModel>("/api/config")
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const refresh = React.useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, refresh };
}

async function request<T>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<{ ok: boolean; data?: T; error?: string; issues?: ConfigIssue[] }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }

  let payload: { ok?: boolean; data?: unknown; error?: { message?: string; details?: unknown } };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return { ok: false, error: `Request failed (${response.status})` };
  }

  if (!payload.ok) {
    // Surface field-level issues (validation errors carry them) so the form can
    // annotate the offending input instead of showing a generic banner.
    const details = payload.error?.details as { issues?: ConfigIssue[] } | undefined;
    return {
      ok: false,
      error: payload.error?.message ?? `Request failed (${response.status})`,
      ...(details?.issues ? { issues: details.issues } : {}),
    };
  }
  return { ok: true, data: payload.data as T };
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  issues?: ConfigIssue[];
}

/** Saves model changes (coder/reviewer/planner) and reloads config in-memory. */
export async function saveModels(models: {
  coder?: string;
  reviewer?: string;
  planner?: string;
}): Promise<SaveResult> {
  return request<ConfigViewModel>("/api/config", "PATCH", { models });
}

/** Validates a draft document without writing it. */
export async function validateConfig(
  draft: unknown,
): Promise<{ valid: boolean; issues?: ConfigIssue[]; error?: string }> {
  const result = await request<{ valid: boolean; issues?: ConfigIssue[] }>(
    "/api/config/validate",
    "POST",
    { document: draft },
  );
  if (!result.ok) return { valid: false, error: result.error, issues: result.issues };
  // The endpoint returns 200 with { valid } for both outcomes.
  return { valid: result.data?.valid ?? false, issues: result.data?.issues };
}

export interface RoleInput {
  role: string;
  defaultModelId: string;
  systemPromptTemplate: string;
  allowedTools?: string[];
}

/** Creates or replaces a role. */
export async function saveRole(role: RoleInput): Promise<SaveResult> {
  const result = await request<ConfigRoleView[]>("/api/config/roles", "POST", role);
  return result.ok ? { ok: true } : { ok: false, error: result.error, issues: result.issues };
}

/** Deletes a custom role. */
export async function deleteRole(role: string): Promise<SaveResult> {
  const result = await request<ConfigRoleView[]>(`/api/config/roles/${encodeURIComponent(role)}`, "DELETE");
  return result.ok ? { ok: true } : { ok: false, error: result.error, issues: result.issues };
}
