<USER_REQUEST>
System/Context Initializer:

Role: You are the Lead Executor & Principal Engineer for the "AI-TEAM V2" migration.
Constraint: You are strictly bound by the provided "Final Architecture Review & Implementation Plan" document. You do NOT have the authority to invent new architectures, bypass security gates, or rewrite the core execution loop.
Philosophy: "Wrap, don't rewrite." "Additive only migrations."

Pesan untuk Antigravity:

Halo Antigravity. Kita akan memulai implementasi AI-TEAM V2. Di bawah ini, saya telah melampirkan dokumen Final Architecture Review & Implementation Plan yang sudah disetujui (berdasarkan review arsitektur tingkat tinggi/Terra).

# AI-TEAM V2 — Final Architecture Review & Implementation Plan

**Status:** FINAL ARCHITECTURE DECISION — implementasi belum dimulai  
**Baseline yang disetujui:** [`TanDjendra/AI-TEAM` `master` @ `1c82caf`](https://github.com/TanDjendra/AI-TEAM/tree/1c82cafef78e24bf62f3dcb3afd656c0acd49d2a)  
**Proposal yang direview:** *AI-TEAM V2 — Architecture Blueprint & Migration Strategy* (Claude Opus 4.6 Thinking)  
**Keputusan:** V2 adalah perluasan inkremental di atas V1, **bukan** penggantian core.

> Dokumen ini adalah spesifikasi untuk executor. Ia tidak mengizinkan perubahan arsitektur besar tanpa review lanjutan.

---

## 1. Executive Decision

V1 sudah memiliki fondasi yang jarang dimiliki orkestrator agent: fakta harness mengalahkan klaim model, reviewer evidence-driven, transisi database atomik, idempotensi event, recovery, kontrol manusia, dashboard, worker, dan abstraksi provider. V2 harus menambah *workflow orchestration* di atas fondasi itu, bukan mengubah task runner V1 menjadi workflow engine.

Arsitektur final V2 menerima lima perluasan inti:

1. **Workflow/DAG terpisah dari Task Execution FSM.** DAG menentukan dependency, readiness, scheduling, dan paralelisme. Setiap node tetap dieksekusi oleh loop V1 `Coder → Test → Reviewer → Fix` yang tidak berubah semantiknya.
2. **Execution isolation yang eksplisit dan re-entrant.** Semua
<truncated 45215 bytes>
roduction-ready if hidden parallel state is not visible/recoverable.
- **Prerequisites:** all prior phases green with feature flags individually testable.
- **Exact scope / WHERE:** extend existing `app/` routes/components and `src/dashboard/service.ts`; extend recovery/sweeper; add benchmark/stress scripts and documentation. Do not start a second frontend/service.
- **Interfaces/contracts:** dashboard exposes workflow graph/readiness, node-to-task mapping, workspace allocation, artifact manifest metadata, budget/reservation state, integration candidate, and actions limited to legal transitions. Secrets, raw artifact content, provider keys, and full transcripts never reach browser.
- **Database changes / migration:** only indexes/read projections justified by measured query plans; no duplicate event store.
- **HOW:** SSE consumes existing ordered journal; add typed workflow events. Recovery detects expired node leases/integration sessions, marks affected workflow/node `BLOCKED`/`NEEDS_HUMAN`, and never replays an in-flight model/tool call.
- **Tests:** API authorization/validation; SSE ordering/dedupe; read-only recovery; action idempotency; load test at max concurrency; chaos test crash during node, artifact publication, and staging integration; accessibility regressions on existing controls.
- **Acceptance criteria:** operator can see why every node is waiting/running/blocked, pause/cancel/retry safely, inspect bounded evidence/artifacts, and recover without logs. Production rollout remains off until the full test matrix and manual fault injection pass.
- **Failure modes:** dashboard/SSE failure does not stop execution; persistence failure blocks completion; recovery ambiguity results in human gate.
- **Rollback:** hide V2 routes/features and set scheduler concurrency one/disabled; V1 dashboard/task controls continue; persistent history remains intact.
- 
<truncated 14116 bytes>

NOTE: The output was truncated because it was too long. Use a more targeted query or a smaller range to get the information you need.