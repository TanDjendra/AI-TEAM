"use client";

/**
 * Create Task form.
 *
 * POSTs to /api/tasks and then hands the created task back to the caller. The
 * task exists in the database as soon as this succeeds — the row and its
 * TASK_CREATED event are written by the service, not by the UI.
 */

import * as React from "react";

import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from "./ui.js";
import { apiPost } from "../lib/use-api.js";
import type { TaskView } from "../../src/dashboard/service.js";

export interface CreateTaskFormProps {
  onCreated?: (task: TaskView) => void;
  className?: string;
  /** Opens expanded; the dashboard keeps it collapsed to stay dense. */
  defaultOpen?: boolean;
}

export function CreateTaskForm({ onCreated, className, defaultOpen = false }: CreateTaskFormProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [externalId, setExternalId] = React.useState("");
  const [maxCycles, setMaxCycles] = React.useState("3");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [notice, setNotice] = React.useState<string | undefined>(undefined);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);

    const result = await apiPost<TaskView>("/api/tasks", {
      title: title.trim(),
      description: description.trim(),
      ...(externalId.trim() ? { externalId: externalId.trim() } : {}),
      maxReviewCycles: Number(maxCycles) || 3,
    });

    setBusy(false);

    if (!result.ok || !result.data) {
      setError(result.error ?? "Could not create the task.");
      return;
    }

    setNotice(`Created ${result.data.externalId}`);
    setTitle("");
    setDescription("");
    setExternalId("");
    onCreated?.(result.data);
  };

  if (!open) {
    return (
      <Panel className={className}>
        <PanelHeader>
          <PanelTitle>New task</PanelTitle>
          <Button type="button" variant="primary" onClick={() => setOpen(true)}>
            Create task
          </Button>
        </PanelHeader>
        <PanelBody>
          <p className="text-[11px] text-[var(--content-faint)]">
            Submit a task to the orchestrator. It is stored immediately and picked up by the coder agent.
          </p>
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel className={className}>
      <PanelHeader>
        <PanelTitle>New task</PanelTitle>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </PanelHeader>

      <PanelBody>
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[10px] font-semibold tracking-[0.12em] text-[var(--content-faint)] uppercase">
                External id
              </span>
              <input
                value={externalId}
                onChange={(event) => setExternalId(event.target.value)}
                placeholder="auto (TASK-…)"
                className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1.5 font-mono text-[11px] text-[var(--content)]"
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-semibold tracking-[0.12em] text-[var(--content-faint)] uppercase">
                Max review cycles
              </span>
              <input
                type="number"
                min={1}
                max={20}
                value={maxCycles}
                onChange={(event) => setMaxCycles(event.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1.5 text-[11px] text-[var(--content)]"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-[10px] font-semibold tracking-[0.12em] text-[var(--content-faint)] uppercase">
              Title
            </span>
            <input
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Create a string utility module with tests"
              className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1.5 text-[11px] text-[var(--content)]"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-semibold tracking-[0.12em] text-[var(--content-faint)] uppercase">
              Description
            </span>
            <textarea
              required
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What should the coder build? Include acceptance criteria."
              className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--content)]"
            />
          </label>

          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" size="md" disabled={busy}>
              {busy ? "Creating…" : "Create task"}
            </Button>
            {notice ? <span className="text-[11px] text-[var(--ok)]">{notice}</span> : null}
          </div>

          {error ? <p className="text-[11px] text-[var(--danger)]">{error}</p> : null}
        </form>
      </PanelBody>
    </Panel>
  );
}
