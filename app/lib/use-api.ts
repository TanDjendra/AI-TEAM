"use client";

/**
 * Minimal client-side data fetching.
 *
 * The dashboard is a control surface: it refreshes on demand and on realtime
 * events, so a tiny hook is clearer than a caching library. Every response is
 * the server's JSON envelope, and errors keep the last good data on screen
 * instead of blanking the panel.
 */

import * as React from "react";

export interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

export interface ApiState<T> {
  data: T | undefined;
  error: string | undefined;
  /** True only for the very first load, so we can show skeletons. */
  loading: boolean;
  refresh: () => void;
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const body = (await response.json()) as Envelope<T>;
  if (!body.ok || body.data === undefined) {
    throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  }
  return body.data;
}

export interface ApiPostResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function apiPost<T>(path: string, body: unknown = {}): Promise<ApiPostResult<T>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Envelope<T>;
  if (!payload.ok) {
    return { ok: false, error: payload.error?.message ?? `Request failed (${response.status})` };
  }
  return { ok: true, data: payload.data as T };
}

export function useApi<T>(path: string): ApiState<T> {
  const [data, setData] = React.useState<T | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading((current) => (data === undefined ? true : current));

    apiGet<T>(path)
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
    // `data` intentionally omitted: the effect must not loop on its own result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce]);

  const refresh = React.useCallback(() => setNonce((value) => value + 1), []);

  return { data, error, loading, refresh };
}
