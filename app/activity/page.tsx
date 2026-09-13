"use client";

/**
 * Global activity page.
 *
 * Historical rows come from GET /api/activity and live events are merged in from
 * the SSE stream, so this page is useful even when realtime is disconnected.
 */

import * as React from "react";

import { LiveActivity } from "../components/live-activity.js";
import { ErrorState, SkeletonRows } from "../components/ui.js";
import { useApi } from "../lib/use-api.js";
import { useEventStream } from "../lib/use-event-stream.js";
import type { ActivityView } from "../../src/dashboard/service.js";

export default function ActivityPage() {
  const { data, error, loading } = useApi<ActivityView[]>("/api/activity?limit=200");
  const stream = useEventStream({ limit: 300 });

  return (
    <div className="flex min-h-0 flex-col gap-3 p-3 lg:p-4">
      {error ? <ErrorState message="Could not load activity history." detail={error} /> : null}

      {loading && !data ? (
        <SkeletonRows rows={6} />
      ) : (
        <LiveActivity
          realtime={stream.entries}
          historical={data ?? []}
          connected={stream.state === "CONNECTED"}
          limit={300}
          className="min-h-0 flex-1"
        />
      )}
    </div>
  );
}
