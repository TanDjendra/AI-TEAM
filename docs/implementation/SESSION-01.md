# AI-TEAM V2 — Implementation Session 01

**Phase:** 1 — Configuration Foundation
**Status:** COMPLETE
**Date:** Session 01
**Model:** DeepSeek V4.1 Flash
**Base commit:** `49138a3` (docs: rewrite README for V2 architecture)

---

## Objective

Build the configuration *foundation* the productization layer depends on, without
touching the orchestration core and without starting any UX (no Product CLI, no
`/setup`, no model discovery, no process launcher).

Scope delivered:

1. `isFirstRun()` / `hasValidConfiguration()`
2. Robust configuration validation (`assessConfiguration`)
3. Atomic `.env` writer
4. `.env.bak` backup before overwrite
5. Safe secret handling
6. Error-label mapping for the (future) wizard
7. Mask helper `••••••••1234`
8. Tests for all of the above

---

## Architectural decisions

### D1 — `ROUTER_API_KEY` stays authoritative in `.env` (C1)

Confirmed with the owner. Consequences honoured in code:

- `ai-team.config.json` remains **SECRET-FREE**.
- No encrypted secret file, no secret in the database.
- `src/config/secret-store.ts` is the **only** writer of environment secrets.
- `.env` remains git-ignored (already true in `.gitignore`).

### D2 — Readiness is NOT file existence

`assessConfiguration()` runs the **same `loadConfig()`** the runtime uses, so its
verdict is exactly what the orchestrator would do at startup. File existence is
reported only as an informational flag.

### D3 — A broken config is a repair, not a first run

Deliberate asymmetry:

- **Missing** API key / coder / reviewer → `firstRun: true`.
- **Present but invalid** config file (`ConfigFileError`) → `firstRun: false`,
  problem code `CONFIG_FILE_INVALID`.
- **Present but misconfigured** (bad URL, identical models) → `firstRun: false`.

This keeps the future wizard from offering "start fresh" over an operator's
existing (merely broken) configuration and silently discarding it.

### D4 — Setup labels layer on the existing taxonomy (no parallel error system)

`src/domain/errors.ts` gains `SetupFailureLabel` + `classifySetupFailure`, which
map the existing `ErrorKind` onto the wizard vocabulary
(`INVALID_URL`, `ROUTER_UNREACHABLE`, `INVALID_API_KEY`, `TIMEOUT`,
`SERVER_ERROR`, `MODEL_NOT_FOUND`, `UNKNOWN`). `classifyHttpStatus` /
`classifyThrown` are untouched.

### D5 — The `.env` writer matches the reader exactly

`parseDotEnv` strips surrounding quotes but performs **no unescaping**. The writer
therefore:

- quotes a value only when it contains whitespace or `#`;
- **refuses** a value containing a raw newline (would inject a line);
- **refuses** a value containing a `"` (the reader cannot represent it
  unambiguously, so writing one would silently corrupt the value on the next
  read). Real API keys never contain quotes.

This asymmetry was found by a test and fixed rather than papered over.

---

## Files changed

### Files added

- `src/config/secret-store.ts` — atomic `.env` writer, `.env.bak` backup,
  non-destructive key upsert, presence checks, `maskSecret`.
- `tests/config/secret-store.test.ts` — 26 tests.
- `tests/config/first-run.test.ts` — 11 tests.
- `tests/unit/setup-errors.test.ts` — 17 tests.

### Files modified

- `src/config/env.ts` — added `assessConfiguration()`, `hasFirstRun` /
  `hasValidConfiguration()` / `isFirstRun()`, `ConfigProblem`,
  `ConfigurationAssessment`. Added the `existsSync` import. **Precedence logic,
  `loadConfig` behaviour and validation messages were NOT changed.**
- `src/domain/errors.ts` — added `SetupFailureLabel`, `isValidHttpUrl`,
  `setupLabelForKind`, `describeSetupLabel`, `classifySetupFailure`. Existing
  exports and behaviour unchanged.

### Files deleted

- None.

---

## Tests run & actual results

### New tests (targeted)

```
npx vitest run tests/config/secret-store.test.ts tests/config/first-run.test.ts tests/unit/setup-errors.test.ts

 Test Files  3 passed (3)
      Tests  54 passed (54)
```

### Full suite

```
npm run verify   (typecheck + vitest run)

 Test Files  1 failed | 39 passed | 1 skipped (41)
      Tests  8 failed | 579 passed | 9 skipped (596)
```

All 54 new tests pass. The 8 failures are **pre-existing** — see Regression.

---

## Regression status

**FOUND — but PRE-EXISTING, not caused by Phase 1.**

- **Symptom:** `tests/unit/config.test.ts` — 8 failures, all showing coder model
  `grib/glm-5.3-flash` instead of `grip/deepseek-v4.1-flash`.
- **Root cause:** the committed `ai-team.config.json` contains
  `"coder": "grib/glm-5.3-flash"` (typo provider + wrong model). Per the V2.1
  precedence rule the JSON file wins over `.env` for models, so `loadConfig()`
  returns the bad value and the tests fail.
- **Proof it is pre-existing:** `git stash push -u` (full working tree reverted to
  `master`) → the **same 8 tests fail identically**. Restored with
  `git stash pop`.
- **Introduced by:** commit `022d2e5` ("feat(v2): complete AI-TEAM V2 architecture
  E2E and UI revamp"), which first added the file.
- **Not touched in Phase 1:** the file is a committed artifact outside this
  phase's scope (see §36 file-change discipline). It is **not** silently
  "corrected by guess".

This matches the **C2** risk recorded in the Phase 0 audit and is carried forward
as a tracked defect (see `STATE.md` → Open defects). It is properly fixed by the
tooling that *produces* configuration — the Phase 2 Product CLI
(`aiteam configure` / `aiteam install` repair path).

No regressions were introduced by Phase 1: every change is additive, and the
8 failures reproduce on the unmodified base.

---

## Security notes

- The `.env` writer never logs a value; `SecretWriteResult` contains only the file
  path, the *names* of keys written, backup/created flags and a truncated hash.
- `envKeysPresent()` returns booleans only — a caller cannot forward a value.
- `maskSecret("sk-live-abcdef1234")` → `••••••••1234`; a short secret is fully
  masked; empty → empty. The full secret is never returned.
- `assessConfiguration().problems[].message` carries `loadConfig`'s diagnostics,
  which already never include the key.
- Newline injection and quote ambiguity are refused, so a value cannot escape its
  line in `.env`.
- Temp file is written `0o600` and removed on failure; the previous `.env` is
  backed up to `.env.bak` before a replace commits.
- No new dependency was added; `node:crypto`, `node:fs`, `node:path` only
  (Windows-safe).
- No secret is written to `ai-team.config.json`, logs, or test output.

---

## Known limitations

- The `.env` writer updates every occurrence of a repeated key; it does not warn
  about duplicates. Acceptable for now (a later phase may add a lint).
- `assessConfiguration` maps error messages to codes by substring against the
  known `loadConfig` diagnostics. If a diagnostic string changes, the mapping
  falls back to `INVALID_ENV` (still truthful, just less specific).
- `firstRun` is a heuristic by design (see D3); callers needing "needs the
  wizard" should read `valid`, not `firstRun` alone. This is documented at the
  call site.

---

## Next session — Phase 2: Product CLI

Per instruction, Phase 2 is **not** started in this session.

Planned scope (from the Phase 0 plan): add the `aiteam` binary + subcommand
router that **delegates to existing services**; `install` (idempotent),
`status` (real checks), `configure` (load → show masked → edit → validate →
backup → save), `models`, `logs`, `update`. Preserve every existing
`npm run task/worker` path unchanged. The pre-existing `ai-team.config.json`
defect is a natural candidate to be repaired through `aiteam install` here.
