# AI-TEAM V2 — EXECUTION PROTOCOL

## 1. PURPOSE

This document defines the permanent execution rules for the AI-TEAM V2 productization project.

The repository is the source of truth.

Do not rely on conversation history as the primary project memory.

Primary sources of truth:

- Actual repository code
- Git history
- docs/implementation/STATE.md
- docs/implementation/SESSION-NN.md
- Tests
- Actual runtime behavior

---

## 2. SESSION MODEL

The implementation is divided into controlled sessions.

### SESSION 1

Phase 0 — Audit
Phase 1 — Configuration Foundation

### SESSION 2

Phase 2 — Product CLI

### SESSION 3

Phase 3 — Next.js Setup Wizard

### SESSION 4

Phase 4 — Model Discovery / Import

### SESSION 5

Phase 5 — Process Launcher

### SESSION 6

Phase 6 — Hardening + Full Regression + Documentation

Do not attempt to complete all phases in one session.

---

## 3. SESSION START

At the beginning of every new session:

1. Read this file.
2. Read docs/implementation/STATE.md.
3. Read the previous session checkpoint.
4. Run git status.
5. Run git log --oneline -10.
6. Inspect the previous phase's commit.
7. Verify the previous phase using the actual repository.
8. Run relevant tests.
9. Only then begin the current phase.

Never assume the previous phase is complete only because a previous chat reported it as complete.

---

## 4. GIT IS PROJECT MEMORY

Conversation history is secondary.

Git history and the actual repository state are authoritative.

Every completed phase must have a Git commit.

Do not rewrite Git history destructively.

Do not use destructive reset operations unless explicitly required and understood.

---

## 5. STATE AND CHECKPOINTS

docs/implementation/STATE.md is the current project state.

docs/implementation/SESSION-NN.md records the work performed in a session.

Keep both synchronized with the actual repository.

A checkpoint should record:

- Phase
- Objective
- Starting commit
- Files added
- Files modified
- Files deleted
- Important architecture decisions
- Tests run
- Actual test results
- Regression status
- Security notes
- Known issues
- Ending commit
- Next session

Never put the following into state or checkpoint files:

- API keys
- Tokens
- Passwords
- Credentials
- Secrets

---

## 6. PHASE BOUNDARY

Every phase follows this sequence:

IMPLEMENT
→ TEST
→ FIX
→ RETEST
→ CHECKPOINT
→ UPDATE STATE.md
→ COMMIT
→ STOP

Do not skip validation, checkpointing, or commit.

---

## 7. HARD STOP RULE

When the current phase is complete:

STOP.

Do not begin the next phase in the same session.

The next phase must begin in a new session.

Correct workflow:

Phase complete
→ tests
→ checkpoint
→ STATE.md
→ commit
→ STOP

Incorrect workflow:

Phase complete
→ immediately start next phase

The purpose is to keep context clean and make every phase independently reviewable.

---

## 8. PREVIOUS PHASE VERIFICATION

At the start of every new session, verify the previous phase.

If STATE.md says COMPLETE but the repository or tests disagree:

BLOCKED

Investigate the previous phase before continuing.

Do not blindly trust historical reports.

---

## 9. CORE PROTECTION

The existing AI-TEAM V2 orchestration core is considered stable.

Be especially conservative with:

- src/domain/*
- src/orchestration/*
- src/agents/*
- src/providers/*
- src/persistence/*

Productization should preferably be implemented around the existing core.

Do not perform broad refactors simply to make implementation easier.

If changing core behavior becomes necessary:

1. Stop.
2. Explain why.
3. Identify affected files.
4. Identify the risk.
5. Choose the smallest safe change.

---

## 10. BACKWARD COMPATIBILITY

Existing developer functionality must remain functional unless explicitly changed by an approved architecture decision.

Current compatibility examples include:

npm run task -- --check-router
npm run task -- --check-db
npm run task -- --plan
npm run task -- --start-scheduler
npm run worker
npm run dev
npm run verify

Do not replace existing functionality when a thin adapter can reuse it.

---

## 11. CONFIGURATION RULE

Maintain one canonical configuration architecture.

Do not create duplicate configuration systems.

Current intended separation:

Secrets
→ .env

Non-secret models/roles/configuration
→ ai-team.config.json

Runtime-only state
→ process/runtime memory

Secrets must never be stored in the JSON configuration.

Reuse existing configuration services whenever possible.

---

## 12. SECRET SAFETY

Never commit:

- API keys
- tokens
- passwords
- private credentials
- .env

Never expose secrets through:

- logs
- stdout
- stderr
- frontend payloads
- checkpoint files
- error messages
- Git

Use the existing redaction and masking infrastructure.

---

## 13. WINDOWS SUPPORT

Windows is a supported development environment.

Do not rely on Unix-only shell behavior.

Avoid assumptions involving:

- cp
- rm
- chmod
- bash-only syntax
- Unix-only process behavior

Prefer cross-platform Node.js APIs.

When executing shell commands, use syntax compatible with the actual environment.

---

## 14. DEPENDENCY RULE

Before adding a dependency:

1. Check whether the repository already provides the capability.
2. Reuse existing dependencies when practical.
3. Add a dependency only when necessary.
4. Document the reason.

Do not add multiple libraries for overlapping functionality.

---

## 15. TESTING RULE

Every phase must have relevant validation.

General checks:

npm run typecheck
npm test
npm run verify

Run additional build, integration, live, or E2E tests when relevant.

Never claim a test passed unless it was actually executed.

---

## 16. TEST FAILURE CLASSIFICATION

If a test failed before the current changes:

PRE-EXISTING FAILURE

If a test begins failing because of the current changes:

REGRESSION

Do not delete, weaken, skip, or bypass a test simply to obtain a green result.

---

## 17. SECURITY STOP CONDITION

Stop immediately when implementation creates uncertainty involving:

- credential persistence
- secret exposure
- unsafe encryption
- arbitrary code execution
- destructive configuration replacement
- unsafe migrations

Do not guess.

Report the issue and identify the safest resolution.

---

## 18. ARCHITECTURE CONFLICT STOP CONDITION

If the existing repository conflicts with the planned architecture, do not silently choose one.

Report:

CONFLICT
CURRENT BEHAVIOR
PLANNED BEHAVIOR
RISK
OPTIONS
RECOMMENDED RESOLUTION

Prefer the smallest safe change.

---

## 19. FILE CHANGE DISCIPLINE

Prefer small, focused changes.

Avoid:

- unrelated formatting
- mass renaming
- unrelated refactors
- unnecessary file churn

At every phase record:

FILES ADDED
FILES MODIFIED
FILES DELETED

---

## 20. COMMIT DISCIPLINE

Prefer one focused commit per completed phase.

Recommended commit convention:

phase-1-config-foundation
phase-2-product-cli
phase-3-setup-wizard
phase-4-model-import
phase-5-process-launcher
phase-6-hardening

Before committing:

git status
git diff --stat
npm run typecheck
npm test
npm run verify

Run additional validation when required.

---

## 21. HANDOFF BETWEEN SESSIONS

A new session must not depend on chat history.

The handoff consists of:

EXECUTION-PROTOCOL.md
+
STATE.md
+
previous SESSION-NN.md
+
Git commit

New session flow:

READ PROTOCOL
→ READ STATE
→ READ PREVIOUS CHECKPOINT
→ VERIFY GIT
→ VERIFY PREVIOUS PHASE
→ EXECUTE CURRENT PHASE

---

## 22. RECOVERY AFTER INTERRUPTION

If a session stops unexpectedly:

1. Inspect git status.
2. Inspect recent commits.
3. Read STATE.md.
4. Read the latest session checkpoint.
5. Inspect current diff.
6. Run relevant tests.

Never assume unfinished work is safe.

If the state is ambiguous:

BLOCKED

Investigate before continuing.

---

## 23. NO FAKE SUCCESS

Never claim:

- tests passed
- router connected
- database healthy
- models imported
- dashboard working
- build successful

unless there is actual evidence.

When appropriate, distinguish:

CONFIRMED
INFERRED
UNKNOWN

---

## 24. PHASE SCOPE RULE

Each session must work only within the assigned phase.

Do not silently implement future-phase functionality.

Phase 2
→ Product CLI only

Phase 3
→ Setup Wizard only

Phase 4
→ Model Discovery / Import only

Phase 5
→ Process Launcher only

Phase 6
→ Hardening / Regression / Documentation only

Small prerequisite changes are allowed only when necessary for the current phase and should be documented.

---

## 25. HUMAN REVIEW BOUNDARY

A phase is not considered approved merely because the executor reports success.

The owner may review:

- diff
- tests
- architecture decisions
- security implications
- commit history

The next session should begin only after the previous phase has been reviewed or explicitly accepted.

---

## 26. FINAL PRINCIPLE

KEEP THE ENGINE

PRODUCTIZE THE EXPERIENCE

USE GIT AS MEMORY

USE CHECKPOINTS AS HANDOFF

STOP AT EVERY PHASE BOUNDARY

VERIFY EVERYTHING
