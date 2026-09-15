import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONFIG_PATH_ENV,
  ConfigFileError,
  EMPTY_CONFIG,
  hashConfig,
  parseConfigFile,
  readConfigFile,
  resolveConfigPath,
  serializeConfigFile,
  statConfigFile,
  validateConfigFile,
  writeConfigFile,
  type AiTeamConfigFile,
} from "../../src/config/config-file.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-team-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function configPath(name = "ai-team.config.json"): string {
  return join(dir, name);
}

const VALID: AiTeamConfigFile = {
  version: 1,
  models: { coder: "grip/deepseek-v4.1-flash", reviewer: "grip/gpt-5.6-luna" },
  catalog: [],
  roles: [],
};

describe("resolveConfigPath", () => {
  it("prefers AI_TEAM_CONFIG_PATH", () => {
    expect(resolveConfigPath({ [CONFIG_PATH_ENV]: "custom.json" }, dir)).toBe(join(dir, "custom.json"));
  });

  it("resolves an absolute AI_TEAM_CONFIG_PATH as-is", () => {
    const absolute = join(dir, "abs.json");
    expect(resolveConfigPath({ [CONFIG_PATH_ENV]: absolute }, dir)).toBe(absolute);
  });

  it("falls back to the default filename in cwd", () => {
    expect(resolveConfigPath({}, dir)).toBe(join(dir, "ai-team.config.json"));
  });

  it("ignores a blank AI_TEAM_CONFIG_PATH", () => {
    expect(resolveConfigPath({ [CONFIG_PATH_ENV]: "   " }, dir)).toBe(join(dir, "ai-team.config.json"));
  });
});

describe("readConfigFile", () => {
  it("treats a missing file as no overrides", () => {
    expect(readConfigFile(configPath())).toEqual(EMPTY_CONFIG);
  });

  it("treats an empty file as no overrides", () => {
    writeFileSync(configPath(), "   \n");
    expect(readConfigFile(configPath())).toEqual(EMPTY_CONFIG);
  });

  it("round-trips a valid file", () => {
    writeConfigFile(configPath(), VALID);
    expect(readConfigFile(configPath())).toEqual(VALID);
  });

  it("rejects a file that is not valid JSON", () => {
    writeFileSync(configPath(), "{ not json ");
    expect(() => readConfigFile(configPath())).toThrowError(ConfigFileError);
    expect(() => readConfigFile(configPath())).toThrowError(/not valid JSON/);
  });

  it("rejects a JSON array as the top level", () => {
    writeFileSync(configPath(), "[]");
    expect(() => readConfigFile(configPath())).toThrowError(/must contain a JSON object/);
  });

  it("rejects an unknown key so a typo cannot become a dead setting", () => {
    writeFileSync(configPath(), JSON.stringify({ ...VALID, modles: {} }));
    try {
      readConfigFile(configPath());
      expect.unreachable("expected ConfigFileError");
    } catch (error) {
      const configError = error as ConfigFileError;
      expect(configError).toBeInstanceOf(ConfigFileError);
      expect(configError.issues.length).toBeGreaterThan(0);
    }
  });

  it("applies schema defaults when optional fields are absent", () => {
    writeFileSync(configPath(), JSON.stringify({ models: { coder: "grip/deepseek-v4.1-flash" } }));
    const parsed = readConfigFile(configPath());
    expect(parsed.version).toBe(1);
    expect(parsed.catalog).toEqual([]);
    expect(parsed.roles).toEqual([]);
  });
});

describe("validation", () => {
  it("rejects a malformed model id with a field-level issue", () => {
    const result = validateConfigFile({ models: { coder: "not-a-model" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "models.coder")).toBe(true);
  });

  it("rejects a role whose name is not a slug", () => {
    const result = validateConfigFile({
      roles: [{ role: "Frontend Coder", defaultModelId: "grip/gpt-5.6-luna", systemPromptTemplate: "x" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "roles.0.role")).toBe(true);
  });

  it("accepts a valid custom role", () => {
    const result = validateConfigFile({
      roles: [
        {
          role: "security-reviewer",
          defaultModelId: "grip/gpt-5.6-luna",
          systemPromptTemplate: "You are a security reviewer.",
          allowedTools: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.roles[0]?.role).toBe("security-reviewer");
  });

  it("parseConfigFile throws with issues for an invalid object", () => {
    expect(() => parseConfigFile({ models: { reviewer: "bad" } })).toThrowError(ConfigFileError);
  });
});

describe("writeConfigFile (atomic)", () => {
  it("creates the file and reports metadata", () => {
    const meta = writeConfigFile(configPath(), VALID);
    expect(meta.exists).toBe(true);
    expect(meta.hash).toBe(hashConfig(serializeConfigFile(VALID)));
    expect(existsSync(configPath())).toBe(true);
  });

  it("leaves no temp file behind", () => {
    writeConfigFile(configPath(), VALID);
    const leftovers = statSync(dir).isDirectory()
      ? readdirNames(dir).filter((name) => name.endsWith(".tmp"))
      : [];
    expect(leftovers).toEqual([]);
  });

  it("keeps a .bak of the previous contents", () => {
    writeConfigFile(configPath(), VALID);
    writeConfigFile(configPath(), { ...VALID, notes: "second write" });
    const backup = readFileSync(`${configPath()}.bak`, "utf8");
    expect(backup).toBe(serializeConfigFile(VALID));
  });

  it("validates before touching disk and refuses invalid input", () => {
    writeConfigFile(configPath(), VALID);
    const before = readFileSync(configPath(), "utf8");
    expect(() =>
      writeConfigFile(configPath(), { ...VALID, models: { coder: "no-slash" } } as AiTeamConfigFile),
    ).toThrowError(ConfigFileError);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("refuses to write into a missing directory", () => {
    expect(() => writeConfigFile(join(dir, "nope", "ai-team.config.json"), VALID)).toThrowError(
      /directory does not exist/,
    );
  });

  it("can skip the backup when asked", () => {
    writeConfigFile(configPath(), VALID, { keepBackup: false });
    writeConfigFile(configPath(), { ...VALID, notes: "x" }, { keepBackup: false });
    expect(existsSync(`${configPath()}.bak`)).toBe(false);
  });

  it("serialises with a trailing newline and stable formatting", () => {
    const serialized = serializeConfigFile(VALID);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).toContain('"version": 1');
  });
});

describe("statConfigFile", () => {
  it("reports a missing file", () => {
    expect(statConfigFile(configPath())).toEqual({ path: configPath(), exists: false });
  });

  it("reports hash and size for an existing file", () => {
    writeConfigFile(configPath(), VALID);
    const meta = statConfigFile(configPath());
    expect(meta.exists).toBe(true);
    expect(meta.sizeBytes).toBeGreaterThan(0);
    expect(meta.hash).toHaveLength(16);
    expect(meta.mtimeMs).toBeGreaterThan(0);
  });
});

function readdirNames(path: string): string[] {
  return readdirSync(path);
}
