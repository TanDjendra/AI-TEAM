<USER_REQUEST>
# AI-TEAM V2 — Architecture Blueprint & Migration Strategy

> **Document purpose**: Analysis + Architecture Blueprint + Migration Strategy for GPT-5.6 Terra/Luna review.
> **Source of truth**: AI-TEAM V1 actual source code (`v1-source/`).
> **Constraint**: ANALYSIS/DESIGN ONLY — no code changes, no implementation.

---

## 0. Executive Summary

AI-TEAM V1 is a **single-task, serial Coder→Reviewer orchestrator** backed by 9Router. It is remarkably well-engineered for its scope: verified tool-call claims, an anti-fake-claim harness, cooperative interrupt via safe-points, a proper event bus with transport fan-out, PostgreSQL persistence with idempotent transitions, and a stale-run recovery service. However, the architecture is fundamentally **single-track**: one task, one coder, one reviewer, one workspace, one model per role.

**V2's mission** is to evolve this into a **multi-task, multi-agent, multi-model orchestration platform** without losing V1's reliability guarantees.

### Key V2 Capabilities Required
| Capability | V1 Status | V2 Target |
|---|---|---|
| Parallel tasks | ❌ Single-task | ✅ N concurrent tasks |
| DAG-based task decomposition | ❌ Linear Coder→Review loop | ✅ DAG with dependency edges |
| Git isolation | ❌ Shared workspace dir | ✅ Git worktree per agent |
| Multi-model routing | ⚠️ 2 hardcoded model slots | ✅ N models via capability registry |
| Specialist agents | ❌ Coder + Reviewer only | ✅ Extensible specialist registry |
| Artifact handoff | ❌ Implicit (shared filesystem) | ✅ Explicit typed artifact protocol |
| Cost governance | ⚠️ Token budgets exist | ✅ Per-task + global cost caps |
| Context isolation | ❌ All in one process memory | ✅ Per-agent context boundary |
| Coordination | ❌ None (single-track) | ✅ Message-passing between agents |

---

## 1. V1 Forensic Audit — Domain Layer

### 1.1 Core Contracts (`domain/types.ts`)

**Strengths (KEEP)**:
- `TaskSpec` — clean task definition with `id`, `title`, `description`, `ac
<truncated 45002 bytes>
rikan ke:

Gemini 3.1 Pro
atau
DeepSeek 4.1 Flash

Executor harus dapat mengikuti plan
tanpa mengambil keputusan arsitektur besar sendiri.

Setiap task harus menjawab:

WHAT
WHY
WHERE
HOW
VERIFY

==================================================
SELF-CRITIQUE
==================================================

Sebelum final:

Cari dan hapus:

- overengineering
- duplicate abstraction
- unnecessary messaging
- unnecessary persistence
- model coupling
- context leakage
- security regression
- migration hazard
- unnecessary refactor

Pertanyaan terakhir:

"Apakah V2 ini benar-benar lebih baik dari V1,
atau hanya lebih kompleks?"

==================================================
OUTPUT
==================================================

Output final harus berisi:

1. Executive Decision
2. Opus Blueprint Critique
3. Corrected V1 → V2 Architecture
4. KEEP / EXTEND / ADAPT / REJECT Matrix
5. Detailed Implementation Plan
6. Migration Strategy
7. Rollback Strategy
8. Testing Strategy
9. Security Checklist
10. Model/Provider Checklist
11. Context Isolation Checklist
12. V1 Compatibility Checklist
13. Definition of Done

Nama dokumen utama:

AI_TEAM_V2_IMPLEMENTATION_PLAN.md

JANGAN CODING.
JANGAN MODIFY REPOSITORY.
JANGAN COMMIT.
JANGAN PUSH.

Kamu hanya melakukan architecture review dan menghasilkan
implementation specification.

STOP setelah dokumen final selesai.
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is: 2026-09-14T18:59:39+07:00.

The user's current state is as follows:
Active Document: d:\Tan\script\PROJECT TEAM\AI TEAM V2\v1-source\README.md (LANGUAGE_MARKDOWN)
Cursor is on line: 676
Other open documents:
- d:\Tan\script\PROJECT TEAM\AI TEAM V2\v1-source\README.md (LANGUAGE_MARKDOWN)
</ADDITIONAL_METADATA>
<USER_SETTINGS_CHANGE>
The user changed setting `Model Selection` from None to Gemini 3.1 Pro (High). No need to comment on this change if the user doesn't ask about it. If reporting what model you are, please use a human readable name instead of the exact string.
</USER_SETTINGS_CHANGE>