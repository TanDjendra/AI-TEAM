/**
 * Phase 1 — secret store tests.
 *
 * These assert the guarantees the C1 decision depends on:
 *  - the `.env` write is atomic and never leaves a temp file behind;
 *  - a `.env.bak` copy of the previous contents is kept before a replace;
 *  - an update preserves unrelated lines, comments and existing values;
 *  - a newline in a value is refused rather than corrupting the file;
 *  - the returned metadata never contains a secret value;
 *  - `maskSecret` reveals only the last 4 characters.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ENV_BACKUP_SUFFIX,
  SecretStoreError,
  envKeysPresent,
  hashContents,
  maskSecret,
  resolveEnvPath,
  upsertEnvLines,
  writeEnvSecrets,
} from "../../src/config/secret-store.js";
import { parseDotEnv } from "../../src/config/env.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-team-secret-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function envPath(name = ".env"): string {
  return join(dir, name);
}

describe("resolveEnvPath", () => {
  it("uses an explicit filePath when provided", () => {
    expect(resolveEnvPath({ filePath: envPath("custom.env") })).toBe(envPath("custom.env"));
  });

  it("defaults to <cwd>/.env", () => {
    expect(resolveEnvPath({ cwd: dir })).toBe(join(dir, ".env"));
  });
});

describe("upsertEnvLines", () => {
  it("updates an existing key in place", () => {
    const next = upsertEnvLines("A=1\nB=2\n", { B: "9" });
    expect(next).toBe("A=1\nB=9\n");
  });

  it("appends a key that does not exist yet", () => {
    const next = upsertEnvLines("A=1\n", { ROUTER_API_KEY: "secret" });
    expect(parseDotEnv(next)).toEqual({ A: "1", ROUTER_API_KEY: "secret" });
  });

  it("preserves comments and blank lines", () => {
    const source = "# header\n\nA=1\n# note\nB=2\n";
    const next = upsertEnvLines(source, { A: "changed" });
    expect(next).toContain("# header");
    expect(next).toContain("# note");
    expect(next).toContain("A=changed");
  });

  it("quotes a value containing spaces or a hash", () => {
    const next = upsertEnvLines("", { NOTE: "hello world", HASH: "a#b" });
    // The parser must read them back verbatim, quotes stripped.
    expect(parseDotEnv(next)).toEqual({ NOTE: "hello world", HASH: "a#b" });
  });

  it("round-trips a value containing a backslash", () => {
    const value = "p\\a\\\\ss";
    const next = upsertEnvLines("", { K: value });
    expect(parseDotEnv(next).K).toBe(value);
  });

  it("refuses a double quote, which the .env reader cannot represent", () => {
    // parseDotEnv strips surrounding quotes without unescaping, so a value with
    // an internal quote would silently change on the next read. Refusing it is
    // the honest contract; real API keys never contain quotes.
    expect(() => upsertEnvLines("", { BAD: 'p"a' })).toThrowError(SecretStoreError);
  });

  it("refuses a value containing a newline", () => {
    expect(() => upsertEnvLines("", { BAD: "line1\nline2" })).toThrowError(SecretStoreError);
  });

  it("preserves CRLF files", () => {
    const next = upsertEnvLines("A=1\r\nB=2\r\n", { B: "3" });
    expect(next).toBe("A=1\r\nB=3\r\n");
  });
});

describe("writeEnvSecrets (atomic)", () => {
  it("creates the file with the secret and reports non-secret metadata", () => {
    const result = writeEnvSecrets(
      { ROUTER_API_KEY: "sk-live-abcdef1234567890" },
      { filePath: envPath() },
    );

    expect(result.created).toBe(true);
    expect(result.writtenKeys).toEqual(["ROUTER_API_KEY"]);
    // The metadata must never carry the value.
    expect(JSON.stringify(result)).not.toContain("sk-live-abcdef1234567890");
    expect(readFileSync(envPath(), "utf8")).toContain("sk-live-abcdef1234567890");
  });

  it("keeps a .env.bak of the previous contents", () => {
    writeEnvSecrets({ ROUTER_API_KEY: "first" }, { filePath: envPath() });
    const result = writeEnvSecrets({ ROUTER_API_KEY: "second" }, { filePath: envPath() });

    expect(result.backupCreated).toBe(true);
    const backup = readFileSync(`${envPath()}${ENV_BACKUP_SUFFIX}`, "utf8");
    expect(backup).toContain("first");
    expect(readFileSync(envPath(), "utf8")).toContain("second");
  });

  it("does not create a backup when the file did not exist", () => {
    const result = writeEnvSecrets({ ROUTER_API_KEY: "x" }, { filePath: envPath() });
    expect(result.backupCreated).toBe(false);
    expect(existsSync(`${envPath()}${ENV_BACKUP_SUFFIX}`)).toBe(false);
  });

  it("can skip the backup when asked", () => {
    writeEnvSecrets({ A: "1" }, { filePath: envPath() });
    writeEnvSecrets({ A: "2" }, { filePath: envPath(), keepBackup: false });
    expect(existsSync(`${envPath()}${ENV_BACKUP_SUFFIX}`)).toBe(false);
  });

  it("preserves unrelated variables across a write", () => {
    writeFileSync(envPath(), "KEEP=me\nROUTER_BASE_URL=http://localhost:20128/v1\n");
    writeEnvSecrets({ ROUTER_API_KEY: "k" }, { filePath: envPath() });

    const parsed = parseDotEnv(readFileSync(envPath(), "utf8"));
    expect(parsed.KEEP).toBe("me");
    expect(parsed.ROUTER_BASE_URL).toBe("http://localhost:20128/v1");
    expect(parsed.ROUTER_API_KEY).toBe("k");
  });

  it("leaves no temp file behind", () => {
    writeEnvSecrets({ A: "1" }, { filePath: envPath() });
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("refuses a value with a newline and leaves the file untouched", () => {
    writeFileSync(envPath(), "A=1\n");
    expect(() => writeEnvSecrets({ BAD: "a\nb" }, { filePath: envPath() })).toThrowError(
      SecretStoreError,
    );
    expect(readFileSync(envPath(), "utf8")).toBe("A=1\n");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses an empty update", () => {
    expect(() => writeEnvSecrets({}, { filePath: envPath() })).toThrowError(/No keys/);
  });

  it("refuses to write into a missing directory", () => {
    expect(() =>
      writeEnvSecrets({ A: "1" }, { filePath: join(dir, "nope", ".env") }),
    ).toThrowError(/directory does not exist/);
  });

  it("reports a hash that matches the resulting contents", () => {
    const result = writeEnvSecrets({ A: "1" }, { filePath: envPath() });
    expect(result.hash).toBe(hashContents(readFileSync(envPath(), "utf8")));
    expect(result.hash).toHaveLength(16);
  });
});

describe("envKeysPresent", () => {
  it("reports presence without exposing the value", () => {
    writeEnvSecrets({ ROUTER_API_KEY: "secret-value", EMPTY: "" }, { filePath: envPath() });
    const present = envKeysPresent(["ROUTER_API_KEY", "EMPTY", "ABSENT"], { filePath: envPath() });
    expect(present).toEqual({ ROUTER_API_KEY: true, EMPTY: false, ABSENT: false });
    expect(JSON.stringify(present)).not.toContain("secret-value");
  });

  it("treats a missing file as nothing present", () => {
    expect(envKeysPresent(["ROUTER_API_KEY"], { filePath: envPath() })).toEqual({
      ROUTER_API_KEY: false,
    });
  });
});

describe("maskSecret", () => {
  it("reveals only the last four characters", () => {
    expect(maskSecret("sk-live-abcdef1234")).toBe("••••••••1234");
  });

  it("does not leak any part of a short secret", () => {
    expect(maskSecret("abc")).toBe("••••••••");
  });

  it("returns an empty string for a missing value", () => {
    expect(maskSecret(undefined)).toBe("");
    expect(maskSecret("")).toBe("");
  });

  it("never returns the full secret", () => {
    const secret = "super-secret-value-9000";
    expect(maskSecret(secret)).not.toContain(secret);
  });
});
