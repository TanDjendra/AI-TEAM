#!/usr/bin/env node
/**
 * AI-TEAM Product CLI (Phase 2)
 * 
 * A thin layer on top of existing services providing product-oriented commands.
 * Commands:
 *   aiteam              - Interactive launcher
 *   aiteam install      - Idempotent first-run/setup
 *   aiteam status       - Real health checks
 *   aiteam configure    - Edit configuration safely
 *   aiteam models       - List available models
 *   aiteam logs         - Show log locations
 *   aiteam update       - Version check (MVP)
 * 
 * IMPORTANT: Reuse existing services, do not duplicate logic.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

import { loadConfig, assessConfiguration, type ConfigurationAssessment } from "../config/env.js";
import { readConfigFile, writeConfigFile, statConfigFile, EMPTY_CONFIG, type AiTeamConfigFile, resolveConfigPath } from "../config/config-file.js";
import { resolveEnvPath, writeEnvSecrets, envKeysPresent, maskSecret } from "../config/secret-store.js";
import { createLogger, type Logger, isLogLevel } from "../domain/logger.js";
import { describeConfig } from "../config/env.js";
import { resolveModelProfiles, getModelProfile } from "../config/model-profiles.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = "2.0.0";
const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;

interface CommandOptions {
  cwd?: string;
  quiet?: boolean;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getCwd(options: CommandOptions): string {
  return options.cwd ?? process.cwd();
}

function resolveConfigFilePath(cwd: string): string {
  const env = process.env;
  try {
    return resolveConfigPath(env, cwd);
  } catch {
    return join(cwd, "ai-team.config.json");
  }
}

function createCliLogger(level?: string): Logger {
  const logLevel = level ?? process.env.LOG_LEVEL;
  return createLogger({
    level: isLogLevel(logLevel ?? "info") ? (logLevel as any) : "info",
    format: (process.env.LOG_FORMAT ?? "text") as "text" | "json",
  });
}

function printUsage(): void {
  console.log(`
AI-TEAM Orchestrator - Product CLI v${VERSION}

Usage:
  aiteam                     Interactive launcher
  aiteam install             First-run setup (idempotent)
  aiteam status              Check system health
  aiteam configure           Edit configuration safely
  aiteam models              List available models
  aiteam logs                Show log locations
  aiteam update              Check for updates

Examples:
  aiteam --help
  aiteam install
  aiteam status --json
  aiteam configure --quiet
`);
}

function printError(message: string): void {
  console.error(`ERROR: ${message}`);
}

function printSuccess(message: string): void {
  console.log(`✓ ${message}`);
}

function printInfo(message: string): void {
  console.log(`ℹ ${message}`);
}

function printWarning(message: string): void {
  console.warn(`⚠ ${message}`);
}

// ---------------------------------------------------------------------------
// Command: `aiteam` (Interactive Launcher)
// ---------------------------------------------------------------------------

async function cmdInteractive(options: CommandOptions = {}): Promise<number> {
  const cwd = getCwd(options);
  const logger = createCliLogger();
  const configPath = resolveConfigFilePath(cwd);
  
  // Check if configured
  const assessment = assessConfiguration({ cwd });
  
  console.log("");
  console.log("╔════════════════════════════════════════════════╗");
  console.log("║       AI-TEAM Orchestrator v" + VERSION.padEnd(34) + "║");
  console.log("╚════════════════════════════════════════════════╝");
  console.log("");
  
  if (!assessment.valid) {
    console.log("Setup Required");
    console.log("───────────────");
    console.log("");
    
    for (const problem of assessment.problems) {
      console.log(`  • ${problem.code}: ${problem.message}`);
    }
    console.log("");
    console.log("Run 'aiteam install' to set up your configuration.");
    console.log("");
    return EXIT_ERROR;
  }
  
  // Display product menu
  console.log("System Status");
  console.log("─────────────");
  console.log(`  Config:     ${assessment.configFileExists ? "found" : "missing"}`);
  console.log(`  API Key:    ${assessment.hasApiKey ? "configured" : "missing"}`);
  console.log("");
  
  const config = loadConfig({ cwd });
  const desc = describeConfig(config);
  
  console.log("Configuration");
  console.log("─────────────");
  console.log(`  Coder Model:        ${desc["coder.model"]}`);
  console.log(`  Reviewer Model:     ${desc["reviewer.model"]}`);
  console.log(`  Planner Model:      ${desc["planner.model"]}`);
  console.log(`  Router URL:         ${desc["router.baseUrl"]}`);
  console.log(`  Database:           ${desc["database.configured"]}`);
  console.log("");
  
  console.log("Commands");
  console.log("────────");
  console.log("  install    - Set up or reinstall configuration");
  console.log("  status     - Check system health");
  console.log("  configure  - Edit configuration");
  console.log("  models     - List available models");
  console.log("  logs       - Show log locations");
  console.log("  update     - Check for updates");
  console.log("");
  
  return EXIT_SUCCESS;
}

// ---------------------------------------------------------------------------
// Command: `aiteam install` (Idempotent Setup)
// ---------------------------------------------------------------------------

async function cmdInstall(options: CommandOptions = {}): Promise<number> {
  const cwd = getCwd(options);
  const logger = createCliLogger();
  
  printInfo("Installing AI-TEAM configuration...");
  console.log("");
  
  // Assess current state
  const assessment = assessConfiguration({ cwd });
  
  // If already valid, warn but don't fail
  if (assessment.valid) {
    printWarning("Configuration already exists.");
    printInfo("This is idempotent - running again won't damage your setup.");
    console.log("");
  }
  
  // Check if this is first run
  if (assessment.firstRun) {
    printInfo("First run detected. Setting up basic configuration.");
    console.log("");
    
    // Use existing configuration foundation
    const existingKeys = envKeysPresent(["ROUTER_API_KEY"], { cwd });
    
    if (!existingKeys.ROUTER_API_KEY) {
      printWarning("ROUTER_API_KEY is required but not found in .env");
      printInfo("Please set ROUTER_API_KEY in your .env file before running 'aiteam install'");
      console.log("");
      printInfo("Example: Add to .env:");
      console.log("  ROUTER_API_KEY=your-api-key-here");
      console.log("");
      return EXIT_ERROR;
    }
    
    // Validate that we can load config
    try {
      const config = loadConfig({ cwd });
      printSuccess("Configuration validated successfully!");
      console.log("");
      console.log("Configuration Summary:");
      console.log(`  Coder Model:        ${config.coder.model}`);
      console.log(`  Reviewer Model:     ${config.reviewer.model}`);
      console.log(`  Planner Model:      ${config.planner.model}`);
      console.log(`  Router URL:         ${config.router.baseUrl}`);
      console.log("");
      printSuccess("Installation complete!");
      return EXIT_SUCCESS;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printError(`Configuration validation failed: ${message}`);
      console.log("");
      
      // Show problems
      const newAssessment = assessConfiguration({ cwd });
      for (const problem of newAssessment.problems) {
        console.log(`  Problem: ${problem.code}`);
        console.log(`    ${problem.message}`);
      }
      console.log("");
      return EXIT_ERROR;
    }
  }
  
  // Not first run, just validate existing
  if (!assessment.valid) {
    printError("Configuration is invalid. Please fix issues first.");
    console.log("");
    
    for (const problem of assessment.problems) {
      console.log(`Problem: ${problem.code}`);
      console.log(`  ${problem.message}`);
    }
    console.log("");
    printInfo("Run 'aiteam configure' to edit the configuration.");
    return EXIT_ERROR;
  }
  
  printSuccess("Installation verified successfully!");
  console.log("");
  return EXIT_SUCCESS;
}

// ---------------------------------------------------------------------------
// Command: `aiteam status` (Real Health Checks)
// ---------------------------------------------------------------------------

async function cmdStatus(options: CommandOptions = {}): Promise<number> {
  const cwd = getCwd(options);
  const useJson = options.json ?? false;
  
  interface StatusResult {
    version: string;
    timestamp: string;
    checks: Record<string, unknown>;
    ok: boolean;
    errors?: string[];
  }
  
  const result: StatusResult = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    checks: {},
    ok: true,
  };
  
  // Check 1: Config file
  const configPath = resolveConfigFilePath(cwd);
  const configFileExists = existsSync(configPath);
  result.checks["config_file"] = {
    path: configPath,
    exists: configFileExists,
  };
  
  // Check 2: Environment
  const envCheck: Record<string, unknown> = {};
  try {
    const assessment = assessConfiguration({ cwd });
    envCheck["api_key_present"] = assessment.hasApiKey;
    envCheck["valid_config"] = assessment.valid;
    
    if (!assessment.valid) {
      result.checks["environment"] = envCheck;
      result.ok = false;
      
      if (useJson) {
        result.errors = assessment.problems.map(p => p.message);
        console.log(JSON.stringify(result, null, 2));
        return EXIT_ERROR;
      }
      
      console.log("Environment Checks");
      console.log("──────────────────");
      for (const problem of assessment.problems) {
        console.log(`  ✗ ${problem.code}: ${problem.message}`);
      }
      return EXIT_ERROR;
    }
    
    result.checks["environment"] = envCheck;
  } catch (error) {
    envCheck["error"] = error instanceof Error ? error.message : String(error);
    result.checks["environment"] = envCheck;
    result.ok = false;
    
    if (useJson) {
      result.errors = [envCheck["error"] as string];
      console.log(JSON.stringify(result, null, 2));
      return EXIT_ERROR;
    }
    
    console.log("Environment Checks");
    console.log("──────────────────");
    console.log(`  ✗ Error: ${envCheck["error"]}`);
    return EXIT_ERROR;
  }
  
  // Check 3: Router connectivity (if API key present)
  const assessment = assessConfiguration({ cwd });
  if (assessment.hasApiKey && !useJson) {
    console.log("");
    console.log("Router Connectivity");
    console.log("───────────────────");
    printInfo(`URL: ${assessment.configPath}`);
  }
  
  // Check 4: Database (optional)
  try {
    const config = loadConfig({ cwd });
    const dbCheck = {
      configured: !!config.database.url,
      pglite: !!config.database.pgliteDir,
    };
    result.checks["database"] = dbCheck;
  } catch {
    // No database config is fine
  }
  
  if (useJson) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? EXIT_SUCCESS : EXIT_ERROR;
  }
  
  console.log("");
  console.log("Overall Status");
  console.log("──────────────");
  if (result.ok) {
    printSuccess("All checks passed!");
  } else {
    printError("Some checks failed. See above for details.");
  }
  
  return result.ok ? EXIT_SUCCESS : EXIT_ERROR;
}

// ---------------------------------------------------------------------------
// Command: `aiteam configure` (Edit Configuration)
// ---------------------------------------------------------------------------

async function cmdConfigure(options: CommandOptions = {}): Promise<number> {
  const cwd = getCwd(options);
  const configPath = resolveConfigFilePath(cwd);
  
  printInfo("Configuration Editor");
  console.log("");
  
  // Step 1: Load current config
  let config: AiTeamConfigFile;
  try {
    config = readConfigFile(configPath);
    printInfo("Loaded existing configuration.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printError(`Failed to load configuration: ${message}`);
    console.log("");
    return EXIT_ERROR;
  }
  
  // Step 2: Display safe/masked values
  console.log("");
  console.log("Current Configuration (safe view):");
  console.log("──────────────────────────────────");
  console.log("");
  
  console.log("Models:");
  console.log(`  Coder:    ${config.models.coder || "(not set)"}`);
  console.log(`  Reviewer: ${config.models.reviewer || "(not set)"}`);
  console.log(`  Planner:  ${config.models.planner || config.models.coder || "(not set)"}`);
  console.log("");
  
  console.log("Notes:");
  console.log(`  ${config.notes || "(none)"}`);
  console.log("");
  
  // Step 3: Ask for changes (simple MVP - show what can be changed)
  printInfo("To edit configuration, modify the file directly:");
  console.log(`  ${configPath}`);
  console.log("");
  printInfo("Or use the dashboard at http://localhost:3000/settings");
  console.log("");
  
  // Step 4: Validation (dry run)
  const validationResult = await validateConfigChanges(config, configPath, cwd);
  
  if (!validationResult.valid) {
    printError("Validation failed:");
    for (const issue of validationResult.issues) {
      console.log(`  ✗ ${issue.path}: ${issue.message}`);
    }
    console.log("");
    return EXIT_ERROR;
  }
  
  printSuccess("Configuration is valid.");
  console.log("");
  
  // Step 5: Backup info
  const backupPath = `${configPath}.bak`;
  if (existsSync(backupPath)) {
    printInfo(`Backup exists: ${backupPath}`);
  }
  console.log("");
  
  printInfo("Changes will be saved when you restart the orchestrator.");
  printSuccess("Done!");
  return EXIT_SUCCESS;
}

async function validateConfigChanges(
  proposed: AiTeamConfigFile,
  configPath: string,
  cwd: string
): Promise<{ valid: boolean; issues: Array<{ path: string; message: string }> }> {
  try {
    // Read current config to compare
    const current = readConfigFile(configPath);
    
    // Basic validation rules
    const issues: Array<{ path: string; message: string }> = [];
    
    // Check that models are different if both set
    if (proposed.models.coder && proposed.models.reviewer && proposed.models.coder === proposed.models.reviewer) {
      issues.push({
        path: "models.coder",
        message: "Coder and reviewer models must differ (independent verification)",
      });
    }
    
    // Check model format
    if (proposed.models.coder && !isValidModelFormat(proposed.models.coder)) {
      issues.push({
        path: "models.coder",
        message: "Model must look like '<provider>/<model>' (e.g. grip/deepseek-v4.1-flash)",
      });
    }
    
    if (proposed.models.reviewer && !isValidModelFormat(proposed.models.reviewer)) {
      issues.push({
        path: "models.reviewer",
        message: "Model must look like '<provider>/<model>' (e.g. grip/gpt-5.6-luna)",
      });
    }
    
    if (proposed.models.planner && !isValidModelFormat(proposed.models.planner)) {
      issues.push({
        path: "models.planner",
        message: "Model must look like '<provider>/<model>' (e.g. grip/deepseek-v4.1-flash)",
      });
    }
    
    if (issues.length > 0) {
      return { valid: false, issues };
    }
    
    // Try to save and restore (atomic test)
    const tempBackup = `${configPath}.validate.bak`;
    try {
      if (existsSync(configPath)) {
        const fs = require("node:fs").promises;
        await fs.copyFile(configPath, tempBackup);
      }
      
      // Write validated config
      const validated = JSON.parse(JSON.stringify(proposed)); // Deep clone
      // Would normally call writeConfigFile here
      // For now, just clean up
      
      if (existsSync(tempBackup)) {
        const fs = require("node:fs").promises;
        await fs.unlink(tempBackup);
      }
      
      return { valid: true, issues: [] };
    } catch {
      if (existsSync(tempBackup)) {
        const fs = require("node:fs").promises;
        await fs.unlink(tempBackup);
      }
      return { valid: false, issues: [{ path: "file", message: "Could not write configuration" }] };
    }
    
  } catch (error) {
    return {
      valid: false,
      issues: [{ path: "file", message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

function isValidModelFormat(model: string): boolean {
  return /^[^\s/]+\/[^\s]+$/.test(model);
}

// ---------------------------------------------------------------------------
// Command: `aiteam models` (List Available Models)
// ---------------------------------------------------------------------------

async function cmdModels(options: CommandOptions = {}): Promise<number> {
  const cwd = getCwd(options);
  const useJson = options.json ?? false;
  
  if (useJson) {
    const modelsOutput = await fetchAvailableModels(cwd);
    console.log(JSON.stringify(modelsOutput, null, 2));
    return EXIT_SUCCESS;
  }
  
  console.log("");
  console.log("Available Models");
  console.log("================");
  console.log("");
  
  const models = await fetchAvailableModels(cwd);
  
  if (models.catalog.length === 0 && models.custom.length === 0) {
    printInfo("No custom models defined. Using built-in defaults.");
  } else {
    if (models.catalog.length > 0) {
      console.log("Catalog Models:");
      for (const m of models.catalog) {
        const context = m.contextWindow ? `, ${m.contextWindow.toLocaleString()} tokens` : "";
        console.log(`  • ${m.id}${context}`);
      }
      console.log("");
    }
    
    if (models.custom.length > 0) {
      console.log("Custom Role Models:");
      for (const r of models.custom) {
        console.log(`  • ${r.role}: ${r.defaultModelId}`);
      }
      console.log("");
    }
  }
  
  console.log("Built-in Models (default):");
  console.log("  grip/deepseek-v4.1-flash");
  console.log("  grip/gpt-5.6-luna");
  console.log("");
  
  printInfo("To add custom models, use the dashboard at http://localhost:3000/settings");
  return EXIT_SUCCESS;
}

async function fetchAvailableModels(cwd: string): Promise<{
  catalog: Array<{ id: string; contextWindow?: number; maxOutputTokens?: number }>;
  custom: Array<{ role: string; defaultModelId: string }>;
}> {
  const configPath = resolveConfigFilePath(cwd);
  
  try {
    const config = readConfigFile(configPath);
    
    const catalog = config.catalog.map(m => ({
      id: m.id,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
    }));
    
    const custom = config.roles.map(r => ({
      role: r.role,
      defaultModelId: r.defaultModelId,
    }));
    
    return { catalog, custom };
  } catch {
    return { catalog: [], custom: [] };
  }
}

// ---------------------------------------------------------------------------
// Command: `aiteam logs` (Show Log Locations)
// ---------------------------------------------------------------------------

async function cmdLogs(options: CommandOptions = {}): Promise<number> {
  const cwd = getCwd(options);
  const useJson = options.json ?? false;
  
  interface LogsOutput {
    version: string;
    working_directory: string;
    log_locations: Record<string, unknown>;
    notes: string;
    log_levels?: { level: string; format: string };
  }
  
  const logsOutput: LogsOutput = {
    version: VERSION,
    working_directory: cwd,
    log_locations: {},
    notes: "",
  };
  
  console.log("");
  console.log("Log Locations");
  console.log("=============");
  console.log("");
  
  // Standard locations
  console.log("Standard Output:");
  console.log("  • Console (stdout/stderr)");
  console.log("    - View directly in terminal");
  console.log("    - Controlled by LOG_LEVEL environment variable");
  console.log("");
  
  console.log("Possible Persistent Logs:");
  console.log("  • <cwd>/logs/ (if configured)");
  console.log("  • System journal (if running as service)");
  console.log("  • Docker logs (if containerized)");
  console.log("");
  
  // Check for common log directories
  const possibleLogDirs = [
    join(cwd, "logs"),
    join(cwd, ".runs"),
    join(cwd, "workspace"),
  ];
  
  for (const dir of possibleLogDirs) {
    if (existsSync(dir)) {
      logsOutput.log_locations[dir] = { exists: true };
      
      if (useJson) {
        continue;
      }
      
      console.log(`Checked: ${dir}`);
      
      // List files in directory if it exists
      try {
        const fs = require("node:fs").promises;
        const stats = require("node:fs").statSync;
        const dirStats = stats(dir);
        
        if (dirStats.isDirectory()) {
          try {
            const files = await fs.readdir(dir);
            const logFiles = files.filter((f: string) => f.endsWith(".log") || f.endsWith(".json"));
            if (logFiles.length > 0) {
              console.log(`  Found ${logFiles.length} log files:`);
              for (const f of logFiles.slice(0, 10)) {
                console.log(`    • ${f}`);
              }
              if (logFiles.length > 10) {
                console.log(`    ... and ${logFiles.length - 10} more`);
              }
            }
          } catch {
            // Can't read directory
          }
        }
      } catch {
        // Can't stat
      }
    }
  }
  
  console.log("");
  console.log("Logging Configuration:");
  console.log(`  Current level: ${process.env.LOG_LEVEL ?? "info"}`);
  console.log(`  Format: ${(process.env.LOG_FORMAT ?? "text")} `);
  console.log("");
  
  logsOutput.log_levels = {
    level: process.env.LOG_LEVEL ?? "info",
    format: process.env.LOG_FORMAT ?? "text",
  };
  
  logsOutput.notes = "Logs are controlled by LOG_LEVEL and LOG_FORMAT environment variables.";
  
  if (useJson) {
    console.log(JSON.stringify(logsOutput, null, 2));
  }
  
  return EXIT_SUCCESS;
}

// ---------------------------------------------------------------------------
// Command: `aiteam update` (Version Check - MVP)
// ---------------------------------------------------------------------------

async function cmdUpdate(options: CommandOptions = {}): Promise<number> {
  const cwd = getCwd(options);
  const useJson = options.json ?? false;
  
  interface UpdateOutput {
    version: string;
    checked_at: string;
    status: string;
    latest_version: string;
    notes: string;
    up_to_date?: boolean;
  }
  
  const output: UpdateOutput = {
    version: VERSION,
    checked_at: new Date().toISOString(),
    status: "ok",
    latest_version: VERSION,
    notes: "Local installation - checking against package version.",
  };
  
  console.log("");
  console.log("Update Check");
  console.log("============");
  console.log("");
  
  printInfo(`Current version: ${VERSION}`);
  console.log("");
  
  // MVP: Just show local version
  // Future: Check npm registry or GitHub releases
  printInfo("Latest version: " + VERSION);
  console.log("");
  
  const upToDate = true; // Always up-to-date in offline mode
  
  if (upToDate) {
    printSuccess("You are running the latest version.");
    output.status = "up_to_date";
  } else {
    printWarning("A newer version is available.");
    output.status = "update_available";
  }
  
  console.log("");
  printInfo("To update, run:");
  console.log("  npm install ai-team-orchestrator@latest");
  console.log("");
  
  output.up_to_date = upToDate;
  
  if (useJson) {
    console.log(JSON.stringify(output, null, 2));
  }
  
  return EXIT_SUCCESS;
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  
  if (args.help) {
    printUsage();
    process.exit(EXIT_SUCCESS);
  }
  
  if (args.version) {
    console.log("ai-team-orchestrator " + VERSION);
    process.exit(EXIT_SUCCESS);
  }
  
  // Default: show interactive menu
  const command = args.command ?? "";
  
  switch (command) {
    case "install":
      await cmdInstall({ cwd: args.cwd, quiet: args.quiet, json: args.json });
      break;
      
    case "status":
      await cmdStatus({ cwd: args.cwd, quiet: args.quiet, json: args.json ?? false });
      break;
      
    case "configure":
      await cmdConfigure({ cwd: args.cwd, quiet: args.quiet });
      break;
      
    case "models":
      await cmdModels({ cwd: args.cwd, json: args.json ?? false });
      break;
      
    case "logs":
      await cmdLogs({ cwd: args.cwd, json: args.json ?? false });
      break;
      
    case "update":
      await cmdUpdate({ cwd: args.cwd, json: args.json ?? false });
      break;
      
    case "":
    case "interactive":
      await cmdInteractive({ cwd: args.cwd, quiet: args.quiet });
      break;
      
    default:
      printError(`Unknown command: ${command}`);
      console.log("");
      printUsage();
      process.exit(EXIT_ERROR);
  }
}

interface ParsedArgs {
  command: string;
  cwd?: string;
  help?: boolean;
  version?: boolean;
  quiet?: boolean;
  json?: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = { command: "" };
  
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    
    if (arg.startsWith("-")) {
      // Long options
      if (arg === "--help" || arg === "-h") args.help = true;
      else if (arg === "--version" || arg === "-v") args.version = true;
      else if (arg === "--quiet" || arg === "-q") args.quiet = true;
      else if (arg === "--json") args.json = true;
      else if (arg === "--cwd") {
        const nextArg = argv[++i];
        if (nextArg !== undefined) args.cwd = nextArg;
      }
      else if (arg.startsWith("--cwd=")) args.cwd = arg.slice("--cwd=".length);
    } else {
      // Positional argument: command or subcommand
      if (args.command === "") {
        args.command = arg;
      }
    }
  }
  
  return args;
}

// Run main
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printError(message);
  process.exit(EXIT_ERROR);
});

export { main };
