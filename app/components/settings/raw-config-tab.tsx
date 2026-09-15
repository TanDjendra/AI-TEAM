"use client";

/**
 * Raw config tab (Phase V2.1).
 *
 * An escape hatch for operators: edit the JSON document directly, validate it on
 * the server, and save. The save goes through the same Zod gate and atomic write
 * as the structured forms, so a malformed document cannot reach disk.
 *
 * The editor holds text, not a parsed object, so a syntax error is visible as
 * text rather than swallowed by a JSON.parse.
 */

import * as React from "react";

import { Badge, Button, FieldError, Mono, Panel, PanelBody, PanelHeader, PanelTitle, Textarea } from "../ui.js";
import { validateConfig, type ConfigIssue, type ConfigViewModel } from "../../lib/use-config.js";

export interface RawConfigTabProps {
  view: ConfigViewModel;
  onSaved: () => void;
}

export function RawConfigTab({ view, onSaved }: RawConfigTabProps) {
  const [text, setText] = React.useState(() => JSON.stringify(view.config, null, 2));
  const [issues, setIssues] = React.useState<ConfigIssue[]>([]);
  const [status, setStatus] = React.useState<{ ok: boolean; message: string } | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  const [parseError, setParseError] = React.useState<string | undefined>(undefined);

  // Re-seed when the server view changes (e.g. after saving from another tab).
  React.useEffect(() => {
    setText(JSON.stringify(view.config, null, 2));
  }, [view.config]);

  const dirty = text !== JSON.stringify(view.config, null, 2);

  const parseDraft = (): { ok: true; value: unknown } | { ok: false; error: string } => {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const handleValidate = async () => {
    setStatus(undefined);
    setIssues([]);
    const parsed = parseDraft();
    if (!parsed.ok) {
      setParseError(parsed.error);
      return;
    }
    setParseError(undefined);
    setBusy(true);
    const result = await validateConfig(parsed.value);
    setBusy(false);
    if (result.valid) {
      setStatus({ ok: true, message: "The document is valid." });
    } else {
      setStatus({ ok: false, message: "The document is not valid." });
      setIssues(result.issues ?? []);
    }
  };

  const handleSave = async () => {
    setStatus(undefined);
    setIssues([]);
    const parsed = parseDraft();
    if (!parsed.ok) {
      setParseError(parsed.error);
      return;
    }
    setParseError(undefined);
    setBusy(true);

    // Saving the whole document uses PATCH with the parsed body, so the same
    // service path validates it. The endpoint only accepts models/catalog/roles/
    // notes — anything else is ignored rather than silently stored.
    const response = await fetch("/api/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.value),
    });
    setBusy(false);

    const payload = (await response.json()) as {
      ok?: boolean;
      error?: { message?: string; details?: { issues?: ConfigIssue[] } };
    };
    if (!payload.ok) {
      setStatus({ ok: false, message: payload.error?.message ?? `Save failed (${response.status}).` });
      setIssues(payload.error?.details?.issues ?? []);
      return;
    }
    setStatus({ ok: true, message: "Saved. The in-memory config has been reloaded." });
    onSaved();
  };

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Raw configuration</PanelTitle>
        <div className="flex items-center gap-2">
          <Badge tone={dirty ? "warn" : "neutral"}>{dirty ? "unsaved" : "in sync"}</Badge>
          <span className="text-[10px] text-[var(--content-faint)]">{view.path}</span>
        </div>
      </PanelHeader>
      <PanelBody className="space-y-3">
        <p className="text-[11px] leading-relaxed text-[var(--content-muted)]">
          Edit the document directly. It is validated against the schema before it is written, and the write is atomic —
          a rejected save leaves the current file untouched.
        </p>

        <Textarea
          rows={18}
          value={text}
          spellCheck={false}
          invalid={Boolean(parseError) || issues.length > 0}
          onChange={(event) => setText(event.target.value)}
          aria-label="Raw configuration JSON"
        />

        {parseError ? <FieldError>Invalid JSON: {parseError}</FieldError> : null}

        {issues.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-[var(--danger)]">
            {issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                <Mono>{issue.path}</Mono> — {issue.message}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
          <Button variant="primary" size="md" disabled={busy} onClick={handleSave}>
            {busy ? "Working…" : "Validate & save"}
          </Button>
          <Button variant="outline" size="md" disabled={busy} onClick={handleValidate}>
            Validate only
          </Button>
          <Button
            variant="ghost"
            size="md"
            disabled={!dirty}
            onClick={() => {
              setText(JSON.stringify(view.config, null, 2));
              setIssues([]);
              setParseError(undefined);
              setStatus(undefined);
            }}
          >
            Reset
          </Button>
        </div>

        {status ? (
          <p className={`text-[11px] ${status.ok ? "text-[var(--ok)]" : "text-[var(--danger)]"}`}>{status.message}</p>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
