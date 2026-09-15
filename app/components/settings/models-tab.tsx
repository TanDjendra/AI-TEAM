"use client";

/**
 * Models tab (Phase V2.1).
 *
 * Lets the owner point the Coder / Reviewer / Planner profiles at different
 * models on the 9Router gateway. Each field is a combobox: pick a known model or
 * type a new "provider/model" string. Nothing is saved until Save, and the server
 * validates before the file is written.
 */

import * as React from "react";

import { Badge, Button, FieldError, Input, Label, Panel, PanelBody, PanelHeader, PanelTitle, Select } from "../ui.js";
import { saveModels, type ConfigIssue, type ConfigViewModel } from "../../lib/use-config.js";

type Stage = "coder" | "reviewer" | "planner";

const STAGES: ReadonlyArray<{ key: Stage; title: string; hint: string }> = [
  { key: "coder", title: "Coder", hint: "Writes the code and runs the tests." },
  { key: "reviewer", title: "Reviewer", hint: "Independently verifies the evidence. Must differ from the Coder." },
  { key: "planner", title: "Planner", hint: "Decomposes an objective into a workflow graph." },
];

export interface ModelsTabProps {
  view: ConfigViewModel;
  onSaved: () => void;
}

export function ModelsTab({ view, onSaved }: ModelsTabProps) {
  const [draft, setDraft] = React.useState<Record<Stage, string>>({
    coder: view.models.coder,
    reviewer: view.models.reviewer,
    planner: view.models.planner,
  });
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<{ ok: boolean; message: string } | undefined>(undefined);
  const [issues, setIssues] = React.useState<ConfigIssue[]>([]);

  // Re-sync when the server view changes (e.g. after a reload from disk).
  React.useEffect(() => {
    setDraft({ coder: view.models.coder, reviewer: view.models.reviewer, planner: view.models.planner });
  }, [view.models.coder, view.models.reviewer, view.models.planner]);

  const dirty =
    draft.coder !== view.models.coder ||
    draft.reviewer !== view.models.reviewer ||
    draft.planner !== view.models.planner;

  const modelsEqual = draft.coder !== "" && draft.coder === draft.reviewer;

  const handleSave = async () => {
    setSaving(true);
    setStatus(undefined);
    setIssues([]);
    const result = await saveModels({ coder: draft.coder, reviewer: draft.reviewer, planner: draft.planner });
    setSaving(false);
    if (result.ok) {
      setStatus({ ok: true, message: "Saved. The in-memory config has been reloaded; the next run uses these models." });
      onSaved();
    } else {
      setStatus({ ok: false, message: result.error ?? "The save was rejected." });
      setIssues(result.issues ?? []);
    }
  };

  const issueFor = (stage: Stage): string | undefined =>
    issues.find((issue) => issue.path === `models.${stage}`)?.message;

  return (
    <div className="space-y-3">
      <Panel>
        <PanelHeader>
          <PanelTitle>Models</PanelTitle>
          <span className="text-[10px] text-[var(--content-faint)]">
            JSON wins over .env · validated before write
          </span>
        </PanelHeader>
        <PanelBody className="space-y-4">
          {STAGES.map((stage) => {
            const source = view.sources[stage.key];
            const value = draft[stage.key];
            const known = view.catalog.some((model) => model.id === value);
            return (
              <div key={stage.key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`model-${stage.key}`}>{stage.title}</Label>
                  <div className="flex items-center gap-2">
                    <Badge tone={source === "config" ? "info" : "neutral"}>
                      {source === "config" ? "from config file" : "from .env"}
                    </Badge>
                    {value ? (
                      <Badge tone={known ? "ok" : "warn"}>
                        {known ? "known model" : "unknown · assumed tool-capable"}
                      </Badge>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id={`model-${stage.key}`}
                    list={`model-catalog-${stage.key}`}
                    value={value}
                    invalid={Boolean(issueFor(stage.key)) || (stage.key === "coder" && modelsEqual)}
                    placeholder="grip/deepseek-v4.1-flash"
                    spellCheck={false}
                    onChange={(event) => setDraft((current) => ({ ...current, [stage.key]: event.target.value }))}
                  />
                  <Select
                    aria-label={`Known ${stage.title} models`}
                    value=""
                    onChange={(event) => {
                      if (!event.target.value) return;
                      setDraft((current) => ({ ...current, [stage.key]: event.target.value }));
                    }}
                    className="sm:w-56"
                  >
                    <option value="">Pick a known model…</option>
                    {view.catalog.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </Select>
                </div>

                <datalist id={`model-catalog-${stage.key}`}>
                  {view.catalog.map((model) => (
                    <option key={model.id} value={model.id} />
                  ))}
                </datalist>

                <p className="text-[11px] text-[var(--content-faint)]">{stage.hint}</p>
                <FieldError>{issueFor(stage.key)}</FieldError>
              </div>
            );
          })}

          {modelsEqual ? (
            <FieldError>Coder and Reviewer must be different models (independent verification).</FieldError>
          ) : null}

          <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
            <Button variant="primary" size="md" disabled={!dirty || saving || modelsEqual} onClick={handleSave}>
              {saving ? "Saving…" : "Save models"}
            </Button>
            <Button
              variant="ghost"
              size="md"
              disabled={!dirty || saving}
              onClick={() =>
                setDraft({
                  coder: view.models.coder,
                  reviewer: view.models.reviewer,
                  planner: view.models.planner,
                })
              }
            >
              Reset
            </Button>
            {dirty ? <span className="text-[11px] text-[var(--warn)]">Unsaved changes</span> : null}
          </div>

          {status ? (
            <p className={`text-[11px] ${status.ok ? "text-[var(--ok)]" : "text-[var(--danger)]"}`}>{status.message}</p>
          ) : null}
        </PanelBody>
      </Panel>
    </div>
  );
}
