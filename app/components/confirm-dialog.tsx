"use client";

/**
 * Minimal modal used for confirmations.
 *
 * A native component rather than `window.confirm`: the dashboard needs to collect
 * a reason/note alongside the confirmation (the audit trail stores it), and a
 * browser dialog cannot. It also keeps the whole flow inside the app's styling and
 * focus handling.
 */

import * as React from "react";

import { Button } from "./ui.js";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What will happen, in the operator's terms. */
  description: string;
  /** Whether to collect a free-text reason (recorded in the audit trail). */
  withNote?: boolean;
  noteLabel?: string;
  notePlaceholder?: string;
  /** Note required before confirming. */
  requireNote?: boolean;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  error?: string;
  onConfirm(note: string): void;
  onCancel(): void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const [note, setNote] = React.useState("");

  // Reset the note each time the dialog opens, so a previous action's note
  // cannot leak into the next confirmation.
  React.useEffect(() => {
    if (props.open) setNote("");
  }, [props.open]);

  React.useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onCancel]);

  if (!props.open) return null;

  const noteMissing = props.requireNote === true && note.trim().length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
    >
      <div className="w-full max-w-md rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] shadow-xl">
        <header className="border-b border-[var(--border-subtle)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--content)]">{props.title}</h2>
        </header>

        <div className="space-y-3 px-4 py-3">
          <p className="text-[11px] leading-relaxed text-[var(--content-muted)]">{props.description}</p>

          {props.withNote ? (
            <label className="block">
              <span className="text-[10px] font-semibold tracking-[0.12em] text-[var(--content-faint)] uppercase">
                {props.noteLabel ?? "Reason"}
                {props.requireNote ? " (required)" : " (optional)"}
              </span>
              <textarea
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={props.notePlaceholder ?? "Why are you taking this action?"}
                className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px] text-[var(--content)]"
              />
            </label>
          ) : null}

          {props.error ? <p className="text-[11px] text-[var(--danger)]">{props.error}</p> : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--border-subtle)] px-4 py-3">
          <Button type="button" variant="ghost" size="md" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
          <Button
            type="button"
            size="md"
            variant={props.destructive ? "danger" : "primary"}
            disabled={props.busy || noteMissing}
            onClick={() => props.onConfirm(note.trim())}
          >
            {props.busy ? "Working…" : (props.confirmLabel ?? "Confirm")}
          </Button>
        </footer>
      </div>
    </div>
  );
}
