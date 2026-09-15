"use client";

/**
 * Tool policy editor (Phase V2.1).
 *
 * The coder's tool set is filtered by `allowedTools` (see coder-agent.ts). This
 * editor exposes exactly those tools so a custom role can be granted a subset.
 *
 * The tool names come from the server's real catalogue, passed in by the parent —
 * never invented here. A role with an empty list gets no tools, which is the
 * correct default for reviewer-style roles.
 */

import * as React from "react";

import { Badge } from "../ui.js";

export interface ToolPolicyEditorProps {
  /** The real tool names the runner exposes, from the server. */
  available: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export function ToolPolicyEditor({ available, value, onChange, disabled }: ToolPolicyEditorProps) {
  const selected = new Set(value);

  const toggle = (tool: string) => {
    if (disabled) return;
    const next = new Set(selected);
    if (next.has(tool)) next.delete(tool);
    else next.add(tool);
    // Keep a stable order: the catalogue order, then anything unknown appended.
    const ordered = available.filter((name) => next.has(name));
    for (const name of next) if (!available.includes(name)) ordered.push(name);
    onChange(ordered);
  };

  if (available.length === 0) {
    return (
      <p className="text-[11px] text-[var(--content-faint)]">
        No tools are registered for this build, so the policy is empty.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {available.map((tool) => {
          const active = selected.has(tool);
          return (
            <button
              key={tool}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => toggle(tool)}
              className={
                "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors " +
                (active
                  ? "border-[var(--coder)] bg-[var(--coder-soft)] text-[var(--coder)]"
                  : "border-[var(--border-subtle)] text-[var(--content-muted)] hover:bg-[var(--surface-sunken)]") +
                (disabled ? " cursor-not-allowed opacity-50" : "")
              }
            >
              {tool}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={value.length === 0 ? "warn" : "neutral"}>
          {value.length === 0 ? "no tools (isolated role)" : `${value.length} tool(s)`}
        </Badge>
      </div>
    </div>
  );
}
