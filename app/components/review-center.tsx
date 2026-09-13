"use client";

/**
 * Review Center.
 *
 * Reviews are append-only in the database (`unique (task_id, cycle)`), so every
 * cycle is shown in order and none can overwrite another. Nothing is summarised
 * away: issues and required fixes are rendered as stored.
 */

import * as React from "react";
import Link from "next/link";

import { Badge, Panel, PanelBody, PanelHeader, PanelTitle } from "./ui.js";
import { cn, formatDateTime } from "../lib/utils.js";
import { severityTone } from "../lib/status.js";
import type { ReviewView } from "../../src/dashboard/service.js";

export function ReviewItem({ review, showTask = true }: { review: ReviewView; showTask?: boolean }) {
  const approved = review.verdict.toUpperCase() === "APPROVED";

  return (
    <article className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-3">
      <header className="flex flex-wrap items-center gap-2">
        <Badge tone={approved ? "ok" : "danger"} dot>
          {review.verdict}
        </Badge>
        <Badge tone={severityTone(review.severity)}>severity {review.severity}</Badge>
        <span className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--content-muted)]">
          cycle {review.cycle}
        </span>
        {showTask && review.taskExternalId ? (
          <Link
            href={`/tasks/${encodeURIComponent(review.taskExternalId)}`}
            className="font-mono text-[10px] text-[var(--content-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--content)]"
          >
            {review.taskExternalId}
          </Link>
        ) : null}
        <span className="ml-auto text-[10px] text-[var(--content-faint)]">{formatDateTime(review.createdAt)}</span>
      </header>

      <p className="mt-2 text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--content)]">{review.summary}</p>

      {review.issues.length > 0 ? (
        <div className="mt-2">
          <h4 className="text-[10px] font-semibold tracking-[0.12em] text-[var(--content-faint)] uppercase">
            Issues ({review.issues.length})
          </h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-[var(--content-muted)]">
            {review.issues.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {review.requiredFixes.length > 0 ? (
        <div className="mt-2">
          <h4 className="text-[10px] font-semibold tracking-[0.12em] text-[var(--warn)] uppercase">
            Required fixes ({review.requiredFixes.length})
          </h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-[var(--content)]">
            {review.requiredFixes.map((fix, index) => (
              <li key={index}>{fix}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer className="mt-2 text-[10px] text-[var(--content-faint)]">reviewer · {review.reviewer}</footer>
    </article>
  );
}

export interface ReviewCenterProps {
  reviews: ReviewView[];
  loading?: boolean;
  error?: string;
  className?: string;
}

export function ReviewCenter({ reviews, loading, error, className }: ReviewCenterProps) {
  return (
    <Panel className={className}>
      <PanelHeader>
        <PanelTitle>Review center</PanelTitle>
        <span className="text-[10px] text-[var(--content-faint)]">{reviews.length} review(s)</span>
      </PanelHeader>

      <PanelBody className={cn("space-y-3", reviews.length > 0 && "max-h-[420px] overflow-y-auto")}>
        {error ? (
          <p className="text-[11px] text-[var(--danger)]">{error}</p>
        ) : loading && reviews.length === 0 ? (
          <p className="text-[11px] text-[var(--content-faint)]">Loading reviews…</p>
        ) : reviews.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-[var(--content-faint)]">
            No reviews yet. A review appears here each time the reviewer judges a task.
          </p>
        ) : (
          reviews.map((review) => <ReviewItem key={review.id} review={review} />)
        )}
      </PanelBody>
    </Panel>
  );
}
