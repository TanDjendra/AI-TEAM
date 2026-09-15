"use client";

/**
 * Roles tab (Phase V2.1).
 *
 * Lists every effective role (built-in + custom) and lets the owner create or
 * edit one by giving it a name, a system prompt template, a default model and a
 * tool policy.
 *
 * Scope honesty (V2.1): custom roles are stored and validated here, but they are
 * NOT yet dispatched by the orchestrator's task loop — only coder/reviewer/planner
 * run today. The UI says so, rather than implying a custom role is already live.
 */

import * as React from "react";

import {
  Badge,
  Button,
  EmptyState,
  FieldError,
  Input,
  Label,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Th,
  Td,
} from "../ui.js";
import { ToolPolicyEditor } from "./tool-policy-editor.js";
import {
  deleteRole,
  saveRole,
  type ConfigIssue,
  type ConfigRoleView,
  type ConfigViewModel,
} from "../../lib/use-config.js";

const ROLE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface Draft {
  role: string;
  defaultModelId: string;
  systemPromptTemplate: string;
  allowedTools: string[];
}

function emptyDraft(defaultModel: string): Draft {
  return { role: "", defaultModelId: defaultModel, systemPromptTemplate: "", allowedTools: [] };
}

function fromView(role: ConfigRoleView): Draft {
  return {
    role: role.role,
    defaultModelId: role.defaultModelId,
    systemPromptTemplate: role.systemPromptTemplate,
    allowedTools: [...role.allowedTools],
  };
}

export interface RolesTabProps {
  view: ConfigViewModel;
  onSaved: () => void;
}

export function RolesTab({ view, onSaved }: RolesTabProps) {
  const [editing, setEditing] = React.useState<ConfigRoleView | undefined>(undefined);
  const [draft, setDraft] = React.useState<Draft>(emptyDraft(view.models.coder));
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<{ ok: boolean; message: string } | undefined>(undefined);
  const [issues, setIssues] = React.useState<ConfigIssue[]>([]);

  const isNew = editing === undefined;
  const roleSlugValid = ROLE_PATTERN.test(draft.role);
  const roleTaken = view.roles.some((role) => role.role === draft.role && role.role !== editing?.role);

  const startNew = () => {
    setEditing(undefined);
    setDraft(emptyDraft(view.models.coder));
    setStatus(undefined);
    setIssues([]);
  };

  const startEdit = (role: ConfigRoleView) => {
    setEditing(role);
    setDraft(fromView(role));
    setStatus(undefined);
    setIssues([]);
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus(undefined);
    setIssues([]);
    const result = await saveRole({
      role: draft.role,
      defaultModelId: draft.defaultModelId,
      systemPromptTemplate: draft.systemPromptTemplate,
      allowedTools: draft.allowedTools,
    });
    setSaving(false);
    if (result.ok) {
      setStatus({
        ok: true,
        message: !isNew || editing
          ? `Role "${draft.role}" saved.`
          : `Role "${draft.role}" created.`,
      });
      setEditing(view.roles.find((role) => role.role === draft.role));
      onSaved();
    } else {
      setStatus({ ok: false, message: result.error ?? "The save was rejected." });
      setIssues(result.issues ?? []);
    }
  };

  const handleDelete = async (role: string) => {
    setSaving(true);
    setStatus(undefined);
    const result = await deleteRole(role);
    setSaving(false);
    if (result.ok) {
      setStatus({ ok: true, message: `Role "${role}" deleted.` });
      if (editing?.role === role) startNew();
      onSaved();
    } else {
      setStatus({ ok: false, message: result.error ?? "The delete was rejected." });
    }
  };

  const issueFor = (field: string): string | undefined =>
    issues.find((issue) => issue.path.endsWith(field))?.message;

  const overriddenCount = view.roles.filter((role) => role.overridden).length;
  const customCount = view.roles.filter((role) => role.custom).length;

  return (
    <div className="space-y-3">
      <Panel>
        <PanelHeader>
          <PanelTitle>Agent roles</PanelTitle>
          <span className="text-[10px] text-[var(--content-faint)]">
            {view.roles.length} role(s) · {overriddenCount} overridden · {customCount} custom
          </span>
        </PanelHeader>
        <PanelBody>
          <div className="text-[11px] leading-relaxed text-[var(--content-muted)]">
            Built-in roles (<code className="font-mono">coder</code>, <code className="font-mono">reviewer</code>,{" "}
            <code className="font-mono">planner</code>) can be overridden but not deleted. Custom roles are stored and
            validated now; the orchestrator will dispatch them in a later phase, so a newly created role is not yet used
            by the task loop.
          </div>
        </PanelBody>
      </Panel>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">Roles</TabsTrigger>
          <TabsTrigger value="editor">{isNew ? "New role" : `Edit: ${editing?.role}`}</TabsTrigger>
        </TabsList>

        <TabsContent value="list">
          <Panel>
            <PanelHeader>
              <PanelTitle>Effective roles</PanelTitle>
              <Button variant="primary" onClick={startNew}>
                New role
              </Button>
            </PanelHeader>
            <PanelBody className="p-0">
              {view.roles.length === 0 ? (
                <EmptyState title="No roles" description="No agent profiles are configured." />
              ) : (
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Role</Th>
                      <Th>Default model</Th>
                      <Th>Tools</Th>
                      <Th>Source</Th>
                      <Th className="text-right">Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.roles.map((role) => (
                      <tr key={role.role}>
                        <Td>
                          <span className="font-mono text-[11px]">{role.role}</span>
                        </Td>
                        <Td>
                          <span className="font-mono text-[11px] text-[var(--content-muted)]">{role.defaultModelId}</span>
                        </Td>
                        <Td>
                          <Badge tone={role.allowedTools.length === 0 ? "warn" : "neutral"}>
                            {role.allowedTools.length === 0 ? "none" : `${role.allowedTools.length}`}
                          </Badge>
                        </Td>
                        <Td>
                          <div className="flex flex-wrap gap-1">
                            {role.builtIn ? <Badge tone="info">built-in</Badge> : <Badge tone="neutral">custom</Badge>}
                            {role.overridden ? <Badge tone="warn">overridden</Badge> : null}
                          </div>
                        </Td>
                        <Td className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button variant="outline" onClick={() => startEdit(role)}>
                              Edit
                            </Button>
                            <Button
                              variant="outline"
                              disabled={!role.builtIn}
                              title={
                                role.builtIn
                                  ? "Built-in roles cannot be deleted"
                                  : `Delete ${role.role}`
                              }
                              onClick={() => startEdit(role)}
                            >
                              …
                            </Button>
                            <Button
                              variant="danger"
                              disabled={role.builtIn || saving}
                              title={role.builtIn ? "Built-in roles cannot be deleted" : undefined}
                              onClick={() => handleDelete(role.role)}
                            >
                              Delete
                            </Button>
                          </div>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </PanelBody>
          </Panel>
        </TabsContent>

        <TabsContent value="editor">
          <Panel>
            <PanelHeader>
              <PanelTitle>{isNew ? "Create a role" : `Edit role: ${editing?.role}`}</PanelTitle>
            </PanelHeader>
            <PanelBody className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="role-name">Role name</Label>
                <Input
                  id="role-name"
                  value={draft.role}
                  spellCheck={false}
                  disabled={!isNew}
                  placeholder="frontend-coder"
                  invalid={Boolean(issueFor("role")) || (draft.role !== "" && (!roleSlugValid || roleTaken))}
                  onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))}
                />
                <p className="text-[11px] text-[var(--content-faint)]">
                  Lowercase slug: letters, digits, dashes. Examples: frontend-coder, security-reviewer.
                </p>
                <FieldError>{issueFor("role")}</FieldError>
                {!isNew ? null : draft.role !== "" && !roleSlugValid ? (
                  <FieldError>Must be a lowercase slug (a–z, 0–9, -).</FieldError>
                ) : roleTaken ? (
                  <FieldError>That role name already exists. Edit it instead.</FieldError>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="role-model">Default model</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="role-model"
                    value={draft.defaultModelId}
                    spellCheck={false}
                    list="role-model-catalog"
                    placeholder="grip/gpt-5.6-luna"
                    invalid={Boolean(issueFor("defaultModelId"))}
                    onChange={(event) => setDraft((current) => ({ ...current, defaultModelId: event.target.value }))}
                  />
                  <Select
                    aria-label="Known models"
                    value=""
                    className="sm:w-56"
                    onChange={(event) => {
                      if (!event.target.value) return;
                      setDraft((current) => ({ ...current, defaultModelId: event.target.value }));
                    }}
                  >
                    <option value="">Pick a known model…</option>
                    {view.catalog.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </Select>
                </div>
                <datalist id="role-model-catalog">
                  {view.catalog.map((model) => (
                    <option key={model.id} value={model.id} />
                  ))}
                </datalist>
                <FieldError>{issueFor("defaultModelId")}</FieldError>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="role-prompt">System prompt template</Label>
                <Textarea
                  id="role-prompt"
                  rows={8}
                  value={draft.systemPromptTemplate}
                  placeholder="You are an expert frontend engineer. Follow the user's instructions exactly."
                  invalid={Boolean(issueFor("systemPromptTemplate"))}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, systemPromptTemplate: event.target.value }))
                  }
                />
                <p className="text-[11px] text-[var(--content-faint)]">
                  {draft.systemPromptTemplate.length} characters. Prepended to the role's built-in prompt.
                </p>
                <FieldError>{issueFor("systemPromptTemplate")}</FieldError>
              </div>

              <div className="space-y-1.5">
                <Label>Tool policy</Label>
                <ToolPolicyEditor
                  available={view.availableTools}
                  value={draft.allowedTools}
                  onChange={(next) => setDraft((current) => ({ ...current, allowedTools: next }))}
                />
              </div>

              <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
                <Button
                  variant="primary"
                  size="md"
                  disabled={saving || !roleSlugValid || draft.defaultModelId.trim() === "" || draft.systemPromptTemplate.trim() === "" || roleTaken}
                  onClick={handleSave}
                >
                  {saving ? "Saving…" : isNew ? "Create role" : "Save role"}
                </Button>
                {!isNew ? (
                  <Button
                    variant="danger"
                    size="md"
                    disabled={saving || (editing?.builtIn ?? false)}
                    title={editing?.builtIn ? "Built-in roles cannot be deleted" : undefined}
                    onClick={() => editing && handleDelete(editing.role)}
                  >
                    Delete role
                  </Button>
                ) : null}
                <Button variant="ghost" size="md" onClick={startNew}>
                  Clear
                </Button>
              </div>

              {status ? (
                <p className={`text-[11px] ${status.ok ? "text-[var(--ok)]" : "text-[var(--danger)]"}`}>
                  {status.message}
                </p>
              ) : null}
            </PanelBody>
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
