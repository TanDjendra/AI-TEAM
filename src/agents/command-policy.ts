export type CommandCategory = "SAFE" | "CONDITIONAL" | "BLOCKED";

export interface PolicyResult {
  category: CommandCategory;
  reason?: string;
  isAllowed: boolean;
}

const SAFE_PREFIXES = [
  "git status",
  "git diff",
  "git log",
  "npm test",
  "npm run build",
  "npm run typecheck",
  "npm install",
  "npm i ",
  "npm ci",
];

const BLOCKED_PATTERNS = [
  // Destructive / system level
  /\b(format|diskpart|shutdown|reboot|halt|poweroff|init 0)\b/i,
  // PowerShell abuse / evasion
  /-EncodedCommand/i,
  /-Enc /i,
  /-ExecutionPolicy Bypass/i,
  /-ep bypass/i,
  /\biex\b/i,
  /\bInvoke-Expression\b/i,
  /\bInvoke-WebRequest\b.*-OutFile\b/i,
  // Piping curl/wget into shell
  /(curl|wget)[^|]*\|\s*(sh|bash|zsh|powershell|pwsh|cmd)/i,
  // rm outside workspace (rough heuristic, exact check needs path resolution but this catches obvious ones)
  /\brm\s+-rf\s+(\/|C:\\|D:\\|[~])/i,
  // Credential dumping / password stores
  /\b(mimikatz|lsass|procdump)\b/i,
  // Registry edits
  /\b(reg add|reg delete)\b/i,
  // Git workspace escape / destruction
  /\bgit\s+(worktree|checkout|switch|reset|clean|push|branch\s+-D)\b/i,
];

export class CommandPolicy {
  static evaluate(command: string): PolicyResult {
    const trimmed = command.trim();
    
    // 1. Check BLOCKED patterns first
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          category: "BLOCKED",
          reason: `Command matched blocked pattern: ${pattern.toString()}`,
          isAllowed: false,
        };
      }
    }

    // 2. Check SAFE prefixes
    for (const prefix of SAFE_PREFIXES) {
      if (trimmed.startsWith(prefix) || trimmed === prefix.trim()) {
        return {
          category: "SAFE",
          isAllowed: true,
        };
      }
    }

    // 3. Fallback to CONDITIONAL
    // These are generic commands (node, npm run X, python, etc.) that are allowed
    // but rely on workspace isolation, timeouts, and redaction for safety.
    return {
      category: "CONDITIONAL",
      isAllowed: true,
    };
  }
}
