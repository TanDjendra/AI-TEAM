"use client";

/** Review Center page: every review, newest first, grouped by task cycle. */

import { ReviewItem } from "../components/review-center.js";
import { EmptyState, ErrorState, Panel, PanelBody, PanelHeader, PanelTitle, SkeletonRows } from "../components/ui.js";
import { useApi } from "../lib/use-api.js";
import type { ReviewView } from "../../src/dashboard/service.js";

export default function ReviewsPage() {
  const { data, error, loading } = useApi<ReviewView[]>("/api/reviews?limit=200");
  const reviews = data ?? [];

  return (
    <div className="space-y-3 p-3 lg:p-4">
      <Panel>
        <PanelHeader>
          <PanelTitle>Review center</PanelTitle>
          <span className="text-[10px] text-[var(--content-faint)]">
            {reviews.length} review(s) · append-only, newest first
          </span>
        </PanelHeader>
      </Panel>

      {loading && !data ? (
        <SkeletonRows rows={4} />
      ) : error ? (
        <ErrorState message="Could not load reviews." detail={error} />
      ) : reviews.length === 0 ? (
        <Panel>
          <PanelBody>
            <EmptyState
              title="No reviews yet"
              description="Each time the reviewer judges a task, its verdict is stored here and never overwritten."
            />
          </PanelBody>
        </Panel>
      ) : (
        <div className="space-y-3">
          {reviews.map((review) => (
            <ReviewItem key={review.id} review={review} />
          ))}
        </div>
      )}
    </div>
  );
}
