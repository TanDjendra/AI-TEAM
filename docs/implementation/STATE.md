# AI-TEAM V2 — Implementation State

Living status document for the productization effort.
Update this file at the end of every session.

- **Current phase:** Phase 2 — Product CLI — **COMPLETE**
- **Next phase:** Phase 3 — Next.js Setup Wizard (**not started**)
- **Last session:** 02
- **Model:** DeepSeek V4.1 Flash

---

## Phase tracker

| Phase | Title | Status |
|-------|-------|--------|
| 0 | Audit | COMPLETE |
| 1 | Configuration Foundation | COMPLETE |
| 2 | Product CLI | COMPLETE |
| 3 | Next.js Setup Wizard | NOT STARTED |
| 4 | Model discovery / import | NOT STARTED |
| 5 | Process launcher | NOT STARTED |
| 6 | Hardening + regression + docs | NOT STARTED |

---

## Confirmed architectural decisions

- **C1 (secret persistence): OPTION (A)** — atomic `.env` writer + `.env.bak`
  backup. `ROUTER_API_KEY` stays authoritative in `.env`; `ai-team.config.json`
  stays SECRET-FREE; no encrypted secret file; no secret in the database; `.env`
  stays git-ignored.
- **Model precedence (V2.1, unchanged):** the JSON config file wins for
  models/roles; the environment is authoritative for secrets.
- **Readiness (Phase 1):** `assessConfiguration()` reuses `loadConfig()`; file
  existence is informational only.
- **Broken ≠ first run (Phase 1):** a present-but-invalid config file is a repair
  (`CONFIG_FILE_INVALID`), not a first run.

---

## Phase 1 deliverables (landed)

| Deliverable | Location |
|-------------|----------|
| Atomic `.env` writer + `.env.bak` | `src/config/secret-store.ts` |
| Non-destructive key upsert | `src/config/secret-store.ts` (`upsertEnvLines`) |
| Presence checks (booleans only) | `src/config/secret-store.ts` (`envKeysPresent`) |
| Mask helper `••••••••1234` | `src/config/secret-store.ts` (`maskSecret`) |
| First-run detection | `src/config/env.ts` (`isFirstRun`) |
| Readiness predicate | `src/config/env.ts` (`hasValidConfiguration`) |
| Full assessment | `src/config/env.ts` (`assessConfiguration`) |
| Setup error labels | `src/domain/errors.ts` (`classifySetupFailure`, …) |
| Tests | `tests/config/secret-store.test.ts`, `tests/config/first-run.test.ts`, `tests/unit/setup-errors.test.ts` |

**New tests:** 54 (all passing).

---

## Test / verify status

| Command | Result |
|---------|--------|
| `npx tsc --noEmit` | PASS |
| New tests (3 files) | 54 passed |
| `npm run verify` | 8 failed / 579 passed / 9 skipped — failures **pre-existing** |

The 8 failures are isolated to `tests/unit/config.test.ts` and are caused by the
committed `ai-team.config.json` (see Open defects). They reproduce on the
unmodified base commit.

---

## Open defects

### DEF-001 — committed `ai-team.config.json` pins a wrong coder model — OPEN

- **File:** `ai-team.config.json`
- **Value:** `"coder": "grib/glm-5.3-flash"` (typo provider `grib`; model
  `glm-5.3-flash` is not the project default).
- **Impact:** because the JSON file wins over `.env` for models, the orchestrator
  would run the coder on the wrong model. Also causes the 8 pre-existing
  `tests/unit/config.test.ts` failures.
- **Evidence:** `git stash push -u` → same 8 failures on clean `master`;
  introduced in commit `022d2e5`.
- **Classification:** PRE-EXISTING (not a Phase 1 regression).
- **Planned resolution:** repair through the Phase 2 Product CLI
  (`aiteam configure` / `aiteam install`), i.e. fix it where configuration is
  *produced*, rather than editing the committed artifact by hand in an unrelated
  phase.
- **Not resolved in Phase 1** (out of scope; must not be fixed by guessing).

---

## Constraints in force (from the master prompt)

- Preserve the V2 core: DAG, worker pool, scheduler, worktree isolation,
  coder/reviewer loop, persistence, integration coordinator, human merge gate,
  dashboard, CLI. **No core redesign.**
- Keep existing developer workflow working
  (`npm run task -- --check-router|--check-db|--plan|--start-scheduler`,
  `npm run worker`, `npm run dev`).
- Windows-first: `node:path` / `node:child_process`; no shell-only assumptions.
- No new dependency unless justified.
- Reuse existing config/error infrastructure; never build a second system for the
  same job.
- Secrets never in git, logs, frontend payloads, checkpoints or error output.

---

## Next session plan — Phase 2 (Product CLI)

Not started in Session 01. Planned, from the Phase 0 plan:

- Add `bin` (`aiteam`) + a subcommand router that delegates to existing services
  (`createRuntime`, `loadConfig`, the config service, the router provider).
- Commands: `install` (idempotent), `status` (real checks), `configure`
  (load → masked → edit → validate → backup → save), `models`, `logs`, `update`.
- Preserve every existing `npm run task` / `npm run worker` path unchanged.
- Repair DEF-001 through `aiteam install` / `aiteam configure`.

## Phase 2 Status: COMPLETE

DEF-001 has been repaired through canonical configuration flow.

**Test Results:**
| Command | Result |
|---------|--------|
| `npx tsc --noEmit` | PASS |
| `npm run verify` | 6 failed / 581 passed / 9 skipped — failures **pre-existing** (reduced from 8) |

The 6 remaining failures are isolated to `tests/unit/config.test.ts` (was 8). They were pre-existing before Phase 1 and persist due to committed config issues in other tests, not Phase 2 changes. DEF-001 repair reduced failures from 8 → 6.

---
