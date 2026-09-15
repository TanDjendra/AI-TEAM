# AI-TEAM V2 Orchestrator

Fondasi **core** untuk sebuah *software engineering team* otonom berbasis *multi-agent* dan sistem terdistribusi. V2 adalah perluasan masif dari arsitektur sebelumnya (V1) yang beralih dari pemrosesan antrean sekuensial (satu per satu) ke orkestrasi paralel berbasis **Directed Acyclic Graph (DAG)** dan **Isolasi Git Worktree**.

```text
Project Owner (Anda)
       │ (1) Submit Workflow (DAG)
       ▼
 ┌────────────────────────────────────────────────────────┐
 │                   Database (PostgreSQL)                │
 │  (State Machine + Dependency Graph + Event Sourcing)   │
 └─┬──────────────────────────┬─────────────────────────┬─┘
   │                          │                         │
   │ (2) Sweep & Release      │ (3) Dispatch READY      │ (6) Present UI & Merge Gate
   ▼                          ▼                         ▼
 [StaleSweeper]          [WorkerPool]             [Dashboard UI]
 (Crash Recovery)             │                   (Next.js + Radix)
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
           Task A (Git Tree A)  Task B (Git Tree B)
             (Coder + Reviewer loop via 9Router)
```

Alur kerja tiap Task:
```text
PENDING → CODING → TESTING → REVIEW
                            ├── APPROVED → (Tunggu Parent Node) → MERGE GATE (Human)
                            └── REJECTED → FIXING → TESTING → REVIEW …
                                                        (maks 3 siklus review)
                            budget habis → NEEDS_HUMAN
```

---

## 1. Fitur Utama Arsitektur V2

Proyek ini tidak hanya menjalankan prompt ke LLM, melainkan membangun sistem operasi mikro untuk agen AI. Terdapat aturan-aturan ketat (*invariants*) yang ditegakkan secara struktural:

### A. Bounded Artifact Isolation (Git Worktree)
Setiap task yang berjalan **tidak pernah** menyentuh folder kerja utama (`main`). Sistem akan otomatis membuat `git worktree` sementara dan terisolasi untuk setiap *worker*. Agen hanya bisa melihat dan mengedit file di dalam cabang sementara mereka.

### B. DAG Workflow Orchestration
Task tidak lagi independen, melainkan terkait dalam bentuk Graf (DAG). **Task C** yang bergantung pada **Task A** dan **Task B** tidak akan pernah dieksekusi sebelum A dan B berstatus `SUCCEEDED` dan artefaknya digabung (*merged*).

### C. Human-in-the-Loop Merge Gate
Setelah agen AI mengklaim tugas selesai (`SUCCEEDED`), kode tersebut **TIDAK** otomatis masuk ke cabang utama. Ia akan berhenti di status `PENDING_MERGE`. Lewat UI Dashboard, *Human* (Anda) bisa melihat *diff* kandidat integrasi dan menekan tombol **Approve & Merge** atau **Reject**.

### D. Re-entrant Review Boundary
Reviewer (`gpt-5.6-luna`) dan Coder (`deepseek-v4.1-flash`) dipisah secara struktural. Reviewer **tidak punya akses** ke filesystem. Reviewer murni bertindak sebagai hakim berdasarkan teks bukti (*evidence*) log eksekusi CLI dan *git diff* yang dikumpulkan secara jujur oleh sistem *Harness*. 

### E. Crash Recovery (Stale Sweeper)
Jika mesin *worker* mati mendadak atau terputus koneksinya (mati listrik, *OOM kill*), task tidak akan menggantung abadi. `StaleSweeper` yang berjalan di *Scheduler Daemon* akan mendeteksi hilangnya detak jantung (*heartbeat*) dan mengubah status task kembali menjadi `BLOCKED` dengan aman tanpa merusak database.

---

## 2. Instalasi & Konfigurasi

```bash
# Instalasi dependensi
npm install

# Salin konfigurasi environment
cp .env.example .env
```

Isi `.env` Anda dengan detail berikut:

```dotenv
ROUTER_BASE_URL=http://localhost:20128/v1
ROUTER_API_KEY=<api key 9Router kamu>     # WAJIB

# Persistence
DATABASE_URL=postgresql://user:pass@host:5432/db 
DATABASE_SSL=true

CODER_MODEL=grip/deepseek-v4.1-flash
REVIEWER_MODEL=grip/gpt-5.6-luna
```

**Catatan Database:** Jika `DATABASE_URL` tidak diisi, sistem akan menggunakan in-memory database atau `PGlite` lokal (berguna untuk testing). Namun untuk pengalaman terdistribusi (Worker + Scheduler + UI secara bersamaan), Anda **Wajib** menyediakan Postgres Server (mis. Supabase lokal atau Docker).

---

## 3. Cara Menjalankan AI-TEAM (Distributed Mode)

Karena V2 adalah sistem terdistribusi multi-proses, Anda harus menjalankan tiga proses utama secara bersamaan di terminal yang terpisah:

### Terminal 1: Dashboard UI (Command Center)
Aplikasi Next.js modern berbasis *Glassmorphism* untuk memonitor tugas, log, agen, dan *Integration Merge Gate*.
```bash
npm run dev
# Buka http://localhost:3000
```

### Terminal 2: Workflow Scheduler Daemon
Otak dari sistem yang membaca DAG, menyelesaikan dependensi antar-tugas, meloloskan task ke antrean eksekusi, dan membersihkan agen yang mati (*crash recovery*).
```bash
npm run task -- --start-scheduler
```

### Terminal 3: Worker Pool Daemon
Sekumpulan *executor* (Tangan sistem). Mereka mem-polling database untuk task yang statusnya `READY`, membuat *git worktree*, dan menjalankan Agen (Coder/Reviewer) di dalamnya.
```bash
npm run worker
```

### Perintah CLI Ekstra
Anda juga dapat berinteraksi tanpa UI menggunakan CLI:
```bash
# Periksa koneksi LLM & Database
npm run task -- --check-router
npm run task -- --check-db

# Buat workflow dari file JSON
npm run task -- --plan --task-file tasks/TASK-001.json
```

---

## 4. Struktur Direktori

```text
src/
  domain/                 # Entitas, Tipe, TaskSpec, Aturan Graf (Tidak ada dependency luar)
  config/                 # Sistem konfigurasi & Env Parser
  persistence/            # Repositori DB (PostgreSQL, Supabase)
  providers/              # Konektor LLM (9Router)
  orchestration/          # Core Engine V2
    workflow-scheduler.ts # Resolusi graf dependensi
    worker.ts             # Daemon eksekusi tugas
    execution-workspace.ts# Git Worktree Manager 
    integration-coordinator.ts # Logika penggabungan merge (V2-10)
  agents/                 # Sistem Agen
    workspace.ts          # Sandbox Filesystem
    tools.ts              # Native Tool Calling (Bash, Read/Write File)
    coder-agent.ts        # AI yang menulis kode
    reviewer-agent.ts     # AI yang mereview bukti
app/                      # Next.js Dashboard UI (Pages & Components)
tests/                    # Test Suite (Unit, Integration, E2E)
```

---

## 5. Kualitas & Pengujian (E2E V2)

Sistem V2 ini sangat disiplin dan diuji hingga 100% lulus dalam **V2 Minimum End-to-End Acceptance Scenario** (`v2-acceptance.test.ts`), yang mencakup:

1. **SC1: Graph Creation**: Eksekusi terprogram yang memastikan Node berjalan secara hirarkis sesuai aturan graf.
2. **SC2: Sequential Execution**: Menjamin Node *Child* selalu diam menunggu seluruh Parent selesai (`SUCCEEDED`).
3. **SC3: Artifact Isolation**: Pembuktian bahwa unmerged branch milik agen benar-benar terkurung (*sandbox*) dan tidak bocor ke pekerjaan agen lain.
4. **SC4: Concurrency & Crash Simulation**: Pembuktian bahwa Stale Sweeper berhasil mengambil alih dan mengamankan state database ketika worker dimatikan secara paksa di tengah jalan.

**Jalankan tes:**
```bash
npm run verify   # Menjalankan Typecheck & Vitest (Semua skenario)
```
Exit code: `0` (Sempurna) / `1` (Ada error infrastruktur atau test gagal).

---

> *"The goal is not to write code faster, but to eliminate the dirty states that make fast coding dangerous."* — AI-TEAM V2 Blueprint.
