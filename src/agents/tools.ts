/**
 * Real tools handed to the Coder agent.
 *
 * "Real" means: `write_file` touches the real filesystem inside the sandbox and
 * `run_command` spawns a real process and returns its real exit code. Nothing
 * here simulates a tool result.
 *
 * The Reviewer gets no tools at all — it is a pure text agent.
 */

import { spawn } from "node:child_process";

import { scrubSecrets, truncate } from "../domain/errors.js";
import type { ModelToolSpec } from "../providers/model-provider.js";
import { CommandPolicy } from "./command-policy.js";
import { Workspace } from "./workspace.js";

export interface ToolExecutionMeta {
  /** Set by run_command. */
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  /** Set by write_file. */
  path?: string;
  action?: "created" | "modified";
}

/**
 * A tool handler returns the text handed back to the model plus optional
 * structured metadata. The metadata is what makes the harness able to verify a
 * model's claims instead of trusting them.
 */
export interface ToolExecutionResult {
  text: string;
  meta?: ToolExecutionMeta;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON-schema-ish parameter description sent to the model. */
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  handler: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface CommandRunnerOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;

/**
 * The names of the tools the coder can actually use.
 *
 * Single source of truth for the V2.1 Settings UI's tool-policy editor: it must
 * offer exactly these, so an operator can never select a tool that does not
 * exist. Note `search_files` is NOT here — it appears in the static coder
 * profile's `allowedTools` but no such tool is registered. Because the agent
 * filters the real tool list by the allow-list, that extra name is currently
 * inert (it matches nothing); it is a pre-existing inconsistency flagged for a
 * separate cleanup, and offering it in the UI would be misleading.
 */
export const CODER_TOOL_NAMES = ["list_files", "read_file", "write_file", "run_command"] as const;

export type CoderToolName = (typeof CODER_TOOL_NAMES)[number];


export class CommandRunner {
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;

  constructor(options: CommandRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }

  run(command: string, cwd: string, override?: { timeoutMs?: number }): Promise<CommandResult> {
    const timeoutMs = override?.timeoutMs ?? this.timeoutMs;
    const startedAt = Date.now();

    return new Promise<CommandResult>((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const cap = (buffer: string, addition: string): string =>
        buffer.length >= this.maxOutputChars
          ? buffer
          : buffer + addition.slice(0, this.maxOutputChars - buffer.length);

      const timer = setTimeout(() => {
        timedOut = true;
        // On Windows the command runs under cmd.exe, so killing the shell alone
        // leaves the real child alive — and because it inherits our stdout pipe,
        // 'close' would never fire and the run would hang. Kill the whole tree.
        //
        // NOTE: do NOT also call child.kill() here. It races taskkill, kills the
        // shell before taskkill can enumerate its children, and orphans the
        // grandchild.
        if (process.platform === "win32" && child.pid) {
          try {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
            killer.on("error", () => {});
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = cap(stdout, chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = cap(stderr, chunk.toString("utf8"));
      });

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          command,
          exitCode,
          stdout: scrubSecrets(stdout),
          stderr: scrubSecrets(stderr),
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      };

      child.on("error", (error: Error) => {
        stderr = cap(stderr, `spawn error: ${error.message}`);
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  }
}

export function createCoderTools(workspace: Workspace, runner: CommandRunner): ToolDefinition[] {
  return [
    {
      name: "list_files",
      description: "List files in the workspace (relative paths, ignores node_modules/.git/dist).",
      parameters: {},
      handler: async () => {
        const files = await workspace.listFiles();
        const text = files.length === 0 ? "(workspace is empty)" : files.map((f) => `${f.path} (${f.bytes}B)`).join("\n");
        return { text };
      },
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        path: { type: "string", description: "Relative file path", required: true },
      },
      handler: async (args) => {
        const path = asString(args.path, "path");
        return { text: await workspace.readText(path) };
      },
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file in the workspace. Always pass the COMPLETE file content; partial content truncates the file.",
      parameters: {
        path: { type: "string", description: "Relative file path", required: true },
        content: { type: "string", description: "Full file content", required: true },
      },
      handler: async (args) => {
        const path = asString(args.path, "path");
        const content = asString(args.content, "content", true);
        const change = await workspace.writeText(path, content);
        return {
          text: `${change.action}: ${change.path} (${change.bytes}B)`,
          meta: { path: change.path, action: change.action },
        };
      },
    },
    {
      name: "run_command",
      description:
        "Run a shell command inside the workspace and return its real exit code, stdout and stderr. Use this to install, typecheck and run tests.",
      parameters: {
        command: { type: "string", description: "Shell command to execute", required: true },
        timeoutMs: { type: "number", description: "Optional timeout in milliseconds" },
      },
      handler: async (args) => {
        const command = asString(args.command, "command");

        const policyResult = CommandPolicy.evaluate(command);
        if (!policyResult.isAllowed) {
          return {
            text: `Command rejected by security policy (category: BLOCKED): ${policyResult.reason || "Unauthorized command"}`,
            meta: {
              command,
              exitCode: 126, // Command invoked cannot execute
              timedOut: false,
              durationMs: 0,
            },
          };
        }

        const timeoutMs =
          typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
            ? Math.min(Math.max(Math.trunc(args.timeoutMs), 1_000), 600_000)
            : undefined;
        const result = await runner.run(command, workspace.root, { timeoutMs });

        const parts = [
          `$ ${command}`,
          `policy_category: ${policyResult.category}`,
          `exit_code: ${result.exitCode ?? "null"}${result.timedOut ? " (TIMED OUT)" : ""}`,
          `duration_ms: ${result.durationMs}`,
        ];
        if (result.stdout.trim()) parts.push(`--- stdout ---\n${truncate(result.stdout, 6_000)}`);
        if (result.stderr.trim()) parts.push(`--- stderr ---\n${truncate(result.stderr, 6_000)}`);

        return {
          text: parts.join("\n"),
          meta: {
            command,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
          },
        };
      },
    },
  ];
}

function asString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new Error(`Tool argument "${field}" must be a non-empty string`);
  }
  return value;
}

export function toolsAsJsonSchema(tools: readonly ToolDefinition[]): ModelToolSpec[] {
  return tools.map((tool) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, spec] of Object.entries(tool.parameters)) {
      properties[name] = { type: spec.type, description: spec.description };
      if (spec.required) required.push(name);
    }
    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      },
    };
  });
}

export function renderToolCatalog(tools: readonly ToolDefinition[]): string {
  return tools
    .map((tool) => {
      const params = Object.entries(tool.parameters)
        .map(([name, spec]) => `${name}${spec.required ? "" : "?"}: ${spec.type}`)
        .join(", ");
      return `- ${tool.name}(${params}) — ${tool.description}`;
    })
    .join("\n");
}
