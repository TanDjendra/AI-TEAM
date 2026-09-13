# AI Team Orchestrator

Fondasi **core** untuk sebuah software engineering team otonom:

```
Project Owner
      â”‚
      â–¼
 Orchestrator            â† state machine + review loop + budget
      â”‚
      â”œâ”€â”€â–º Coder Agent    (grip/deepseek-v4.1-flash via 9Router)
      â”‚         â”‚
      â”‚         â–¼
      â””â”€â”€â–º Reviewer Agent (grip/gpt-5.6-luna via 9Router)
```

Alur kerja:

```
TASK â†’ CODING â†’ TESTING â†’ REVIEW
                            â”œâ”€â”€ APPROVED â†’ DONE
                            â””â”€â”€ REJECTED â†’ FIXING â†’ TESTING â†’ REVIEW â€¦
                                                        (maks 3 siklus review)
                            budget habis â†’ NEEDS_HUMAN
```

Belum ada dashboard, dan memang tidak ada di ruang lingkup ini.

---

## 1. Yang membuat proyek ini bukan main-main

Tiga keputusan desain yang membedakannya dari orkestrator "AI coding" biasa:

**1. Tool itu nyata, bukan simulasi.** `CoderAgent` benar-benar menulis file dan
benar-benar menjalankan proses (`node --test`, `npm test`, dst.) di dalam sandbox.
Setiap pemanggilan tool mengembalikan *metadata terstruktur*: exit code asli,
`timedOut`, durasi.

**1b. Tool calling native + pemulihan tool-call berbentuk teks.** Tool dikirim
sebagai definisi fungsi OpenAI (`tools`), dan `tool_calls` dari model dieksekusi
langsung. Kalau model mengeluarkan tool call sebagai **teks** â€” XML
`<tool_call><invoke name="â€¦">` (inilah yang DeepSeek V4.1 Flash lakukan) atau JSON
ber-fence â€” panggilan itu tetap dideteksi dan dieksekusi. Teks **tidak pernah**
dianggap pekerjaan selesai.

**2. Harness menimpa klaim model.** Ini inti sistemnya. `files_changed`,
`tests_run`, dan `tests_passed` dari model **ditimpa** dengan fakta yang direkam
harness. Coder yang bilang "tests_passed: true" tanpa pernah menjalankan test akan
terbaca sebagai `tests_passed: false` + issue
`"The coder reported tests_passed=true but executed no test command."`

**2b. Completion guard.** Model tidak bisa mengklaim selesai tanpa bekerja.
`status: DONE` **ditolak** kalau harness tidak melihat satu pun tool dieksekusi
(`phase=NO_TOOL_USE`), atau kalau belum ada perintah test yang benar-benar
dijalankan (`phase=NO_TEST_RUN`).

**3. Reviewer independen secara struktural.** `ReviewerAgent` tidak punya
`Workspace` dan tidak punya tool sama sekali. Ia hanya menerima teks bukti yang
disusun harness dari filesystem nyata dan log eksekusi nyata â€” termasuk bagian
**"WHAT THE HARNESS COULD NOT VERIFY"** yang jujur menyebut apa yang tidak bisa
dibuktikan.

---

## 2. Instalasi

```bash
npm install
cp .env.example .env
```

Isi `.env`:

```dotenv
ROUTER_BASE_URL=http://localhost:20128/v1
ROUTER_API_KEY=<api key 9Router kamu>     # WAJIB
CODER_MODEL=grip/deepseek-v4.1-flash
REVIEWER_MODEL=grip/gpt-5.6-luna
ROUTER_VERIFY_ON_START=true               # opsional: gagal cepat saat start
```

`ROUTER_API_KEY` **tidak pernah** di-hardcode dan **tidak punya fallback**.

Dua jebakan 9Router yang sudah diverifikasi, dan kenapa desainnya begini:

1. **`GET /v1/models` tidak menegakkan auth** â€” request tanpa key tetap `200 OK`.
   Artinya model listing bukan bukti kredensial valid. Karena itu:
   - `ProviderHealth.authVerified` selalu `false` untuk hasil `health()`;
   - ada `verifyChat(model)` yang mengirim completion nyata (`max_tokens: 1`)
     sebagai satu-satunya sinyal "siap" yang bisa dipercaya;
   - `npm run router:check` memakai probe itu untuk memutuskan `ok`.
2. **Secret CLI 9Router di disk (`%APPDATA%\9router\auth\cli-secret`) ditolak
   `401`** oleh `/v1/chat/completions`. Versi awal proyek ini memakainya sebagai
   fallback; itu keliru dan berbahaya (memperlakukan secret aplikasi lain sebagai
   kredensial router). Sudah dihapus, dan ada test yang mengunci perilaku itu.

Konsekuensinya: kalau `ROUTER_API_KEY` kosong, `loadConfig()` menolak start
dengan pesan jelas â€” bukan gagal diam-diam di tengah run.

---

## 3. Menjalankan

```bash
# 1. Pastikan 9Router hidup dan kedua model benar-benar dilayani
npm run router:check

# 2. Jalankan satu task
npm run task                                   # tasks/TASK-001.json
npm run task -- --task-file tasks/foo.json
npm run task -- --json                         # ringkasan machine-readable

# 3. Verifikasi kualitas
npm run verify                                 # typecheck + 109 unit test
```

Exit code: `0` = `DONE` (approved), `2` = `NEEDS_HUMAN`, `1` = error
konfigurasi/infrastruktur.

Artefak setiap run ditulis ke `.runs/<TASK-ID>.json` dan `.runs/<TASK-ID>.md`.

Test live (memanggil 9Router sungguhan, butuh kredit):

```bash
RUN_LIVE=1 npx vitest run tests/live
```

---

## 4. Struktur

```
src/
  domain/                 # tidak bergantung pada apa pun
    types.ts              # Agent, AgentInput/Output, kontrak Coder & Reviewer
    task-machine.ts       # tabel transisi + kebijakan budget review
    errors.ts             # taksonomi error + scrubber secret
    logger.ts             # structured logging (JSON per baris)
  config/
    env.ts                # konfigurasi 9Router + validasi + .env parser
  providers/
    model-provider.ts     # interface ModelProvider
    router-provider.ts    # implementasi 9Router (HTTP nyata, retry, SSE)
  agents/
    workspace.ts          # sandbox filesystem + penolakan path traversal
    tools.ts              # tool nyata: list/read/write/run_command
    base-agent.ts         # parsing JSON & protokol tool-call
    prompts.ts            # system prompt + kontrak output
    evidence.ts           # penyusun bukti untuk reviewer
    coder-agent.ts        # CoderAgent
    reviewer-agent.ts     # ReviewerAgent
  orchestration/
    runner.ts             # OrchestratorService + review loop
    container.ts          # composition root (satu-satunya tempat provider dipilih)
    report.ts             # ringkasan & laporan run
  cli.ts                  # CLI
  index.ts                # public API
```

Aturan lapisan (dijaga saat review): `domain` â† `providers` â† `agents` â†
`orchestration`. Orchestrator hanya tahu `Agent` dan `ModelProvider` (interface),
tidak pernah implementasi konkretnya.

---

## 5. Interface publik

```ts
interface Agent {
  id: string;
  role: string;
  execute(input: AgentInput): Promise<AgentOutput>;
}

interface ModelProvider {
  id: string;
  baseUrl: string;
  chat(input: ModelRequest): Promise<ModelResponse>;
  chatStream(input: ModelRequest): AsyncGenerator<ChatStreamChunk, ModelResponse, void>;
  listModels(): Promise<string[]>;
  health(): Promise<ProviderHealth>;
}
```

Provider dipisahkan dari agent supaya model bisa diganti tanpa menyentuh
orchestrator: cukup ubah `CODER_MODEL` / `REVIEWER_MODEL`, atau pasang
implementasi `ModelProvider` lain lewat `createRuntime({ provider })`.

### Kontrak output

Coder (wajib dari model):

```json
{
  "status": "DONE",
  "summary": "...",
  "files_changed": ["src/index.js"],
  "tests_run": ["npm test"],
  "tests_passed": true,
  "issues": [],
  "notes": "..."
}
```

Reviewer (wajib dari model):

```json
{
  "verdict": "APPROVED",
  "summary": "...",
  "issues": [],
  "required_fixes": [],
  "severity": "NONE"
}
```

Field tambahan **yang ditambahkan harness** (bukan model) pada output coder:
`executed_commands[]` â€” daftar perintah yang benar-benar dijalankan beserta exit
code aslinya. Inilah yang diverifikasi reviewer.

---

## 6. State machine

| Dari | Boleh ke |
|---|---|
| PENDING | CODING |
| CODING | TESTING |
| TESTING | REVIEW |
| REVIEW | APPROVED, REJECTED |
| REJECTED | FIXING |
| FIXING | TESTING |
| APPROVED | DONE |
| DONE / NEEDS_HUMAN | â€” (terminal) |

Transisi ilegal melempar `IllegalStateTransitionError`; tidak ada jalur "diam-diam
lanjut".

Dua catatan desain yang disengaja, keduanya keluar dari spesifikasi literal:

1. **`APPROVED â†’ DONE` ditambahkan.** Tanpa edge itu, `DONE` tidak punya
   predecessor dan acceptance criteria (`final state DONE`) mustahil dipenuhi.
2. **`FAILED â†’ REJECTED â†’ â€¦` disederhanakan menjadi `REJECTED â†’ FIXING`.** Karena
   tiap review pass sudah terbatas `MAX_REVIEW_CYCLES` (dan setiap run di-bounds
   `maxAgentAttempts` per pemanggilan), state `FAILED` terpisah hanya akan menjadi
   alias dari `REJECTED` dan merusak invarian "satu `REJECTED` = satu siklus".

Cara berhenti saat budget habis: orkestrator mencatat state terminal langsung
lewat `reachableTerminal()` (mis. `REVIEW â†’ NEEDS_HUMAN`), bukan dengan
menciptakan edge transisi palsu. Jadi tabel di atas tetap deskripsi jalur normal,
sementara kehabisan budget adalah keputusan kebijakan, bukan transisi.

---

## 7. Review loop & limit

`reviewCycles` dinaikkan **saat masuk** state `REVIEW`. Jadi:

| `MAX_REVIEW_CYCLES` | Review pass | Pemanggilan Coder |
|---|---|---|
| 1 | 1 | 1 |
| 2 | 2 | 2 |
| **3 (default)** | **3** | **3** |

Setelah pass terakhir ditolak, tidak ada budget untuk fix â€” loop berhenti dengan
`NEEDS_HUMAN` dan `stopReason: "MAX_REVIEW_CYCLES"`.

Reviewer **selalu** dipanggil, termasuk pada pass terakhir. Tidak ada jalur
"DONE by exhaustion"; satu-satunya jalan ke `DONE` adalah verdict `APPROVED`.

`stopReason` yang mungkin: `MAX_REVIEW_CYCLES`, `REVIEWER_UNAVAILABLE`,
`CODER_UNAVAILABLE`, `TESTS_FAILED_AFTER_FIX`, `INVALID_AGENT_OUTPUT`.

### Jaring pengaman struktural

- `APPROVED` dengan severity `HIGH`/`CRITICAL` â†’ otomatis diturunkan jadi
  `REJECTED`.
- `APPROVED` dengan `required_fixes` tidak kosong â†’ otomatis `REJECTED`.
- Verdict tidak terbaca â†’ `REJECTED` (tidak pernah "approve karena bingung").
- Semua panggilan agent yang gagal di-retry sampai `MAX_AGENT_ATTEMPTS`; hanya
  kegagalan *infrastruktur* (tidak ada contract yang bisa dibaca + ada `error`)
  yang menghentikan run. Coder yang jujur melapor `BLOCKED` tetap diteruskan ke
  reviewer untuk dinilai.

---

## 8. Hasil verifikasi

- `npm run typecheck` â€” bersih (`tsc --noEmit`, strict)
- `npm test` â€” **133 lulus**, 9 live test di-skip kecuali `RUN_LIVE=1`
- **E2E `TASK-001` â†’ `DONE`** lewat 9Router (lihat di bawah)

### E2E nyata: TASK-001

```
PENDING -> CODING -> TESTING -> REVIEW -> APPROVED -> DONE
Review cycles: 1 / 3        Coder calls: 1 (26s)   Reviewer calls: 2
Coder (harness-verified):
  files_changed : package.json, src/index.js, test/index.test.js
  tests_passed  : true
  tool calls    : 16 across 4 tools
  commands      : 7 (final exit 0)
Reviewer: APPROVED (severity NONE)
```

Diverifikasi ulang secara independen di luar orkestrator: `npm test` di workspace
itu **11/11 lulus, exit 0**.

### Catatan 9Router yang ditemukan saat implementasi

Semuanya sudah ditangani, dan masing-masing punya test:

- **Native function calling didukung** dan itulah jalur utama: `finish_reason:
  "tool_calls"` + `message.tool_calls[]`, untuk `grip/deepseek-v4.1-flash`
  maupun `grip/gpt-5.6-luna`. `tool_choice` juga diterima.
- **Model juga bisa mengeluarkan tool call sebagai teks.** DeepSeek V4.1 Flash
  pernah mengirim `<tool_call><invoke name="bash">â€¦` dalam `content`. Ini pernah
  membuat seluruh task gagal (lihat bagian 9) dan sekarang dipulihkan, bukan
  dianggap jawaban final.
- `data: [DONE]` ikut dikirim pada respons **non-stream** â†’ `response.json()`
  polos gagal. Ditangani `stripTrailingSseFrames()` dengan pemindaian brace yang
  sadar-string (bukan `indexOf("data:")`, yang akan memotong payload valid).
- `GET /v1/models` **tidak butuh auth** â†’ tidak bisa dipakai memvalidasi key.
- Secret CLI di disk **bukan** kredensial API yang valid (401).
- `/v1/chat/completions` menegakkan auth (401 tanpa key yang benar).

---

## 9. Post-mortem: kenapa TASK-001 awalnya gagal total

Gejala yang dilaporkan: *"DeepSeek V4.1 Flash berhasil dipanggil lewat 9Router,
tetapi CoderAgent tidak melakukan tool call sama sekali."* Gejala itu benar, tapi
penyebabnya bukan "model malas".

**Bukti dari run yang gagal** (`coder.raw`):

```
I'll start by inspecting the workspace.

<tool_call>
<invoke name="bash">
<parameter name="command">pwd && ls -la && node --version && npm --version</parameter>
</invoke>
</tool_call>
```

Model **memang** memanggil tool. Ia mengeluarkannya dalam **format XML tool-call
native**, sementara kode hanya mengenali satu bentuk: fenced JSON ` ```tool `.

**Root cause:** prompt meminta satu format yang tidak native bagi model, dan
router tidak diberikan definisi `tools` sama sekali. Karena itu:

1. Router tidak pernah mengirim `tools` â†’ model mengarang protokol sendiri (XML).
2. Parser tidak mengenali XML â†’ teks itu dianggap **jawaban final**.
3. Tidak ada JSON contract â†’ `BLOCKED`, workspace kosong.
4. Reviewer menolak dengan benar, 3 siklus habis, `NEEDS_HUMAN`.

Jadi kegagalannya ada di sisi implementasi (antarmuka tool), bukan di model â€”
dan reviewer **tidak** disentuh untuk memperbaikinya.

**Perbaikan:**

1. **Native tool calling.** Tool dikirim sebagai definisi fungsi OpenAI; `tool_calls`
   dieksekusi langsung. Diverifikasi didukung 9Router untuk kedua model.
2. **Pemulihan tool-call berbentuk teks.** XML (`<tool_call><invoke>`), Hermes
   (`<tool_call>{...}</tool_call>`), fenced JSON, dan bare JSON semuanya dikenali
   dan **dieksekusi**. Teks tidak pernah dianggap pekerjaan selesai.
3. **Completion guard.** `DONE` ditolak bila harness tidak melihat tool dieksekusi,
   bila tidak ada test dijalankan, atau bila test terakhir tidak lulus.
4. **Bug `tests_passed` yang kontradiktif.** Semantik lama "semua perintah harus
   exit 0" salah: probe eksploratif yang gagal membuat laporan menulis
   `tests_passed: false` padahal verdict-nya `APPROVED`. Sekarang **test run
   terakhir** yang otoritatif, dan kegagalan sebelumnya dilaporkan sebagai catatan.
   (Timeout tetap menggagalkan run.)
5. Instruksi eksplisit per fase: initial â†’ *"You are an autonomous coding agent.
   Do not merely explain what should be doneâ€¦"*; fix â†’ *"Do not only describe the
   fixes. Actually modify the files and run the tests."*

**Regression test** yang mengunci bug ini:

- `parses the native XML form DeepSeek actually emitted (TASK-001 regression)`
- `recovers an XML tool call from text instead of treating it as a final answer`
- `keeps looping through the XML path across turns`
- `refuses a DONE claim when the model performed no work at all`
- `uses the LAST test run as the authoritative result (real TASK-001 shape)`
- plus live guard: `expect(coderDidWork).toBe(true)` pada E2E.

---

## 10. Batasan yang masih tersisa

- **Sandbox bukan isolasi keamanan.** Workspace menolak path traversal, tapi tidak
  ada container/jail OS. Perintah berjalan dengan hak user yang sama.
- **Tidak ada checkpoint/resume.** Run yang mati di tengah tidak dilanjutkan dari
  state terakhir; `.runs/*.json` hanya untuk post-mortem.
- **Verifikasi masih tekstual.** Reviewer tidak bisa menjalankan test sendiri
  (memang disengaja), jadi ia bergantung pada log yang direkam harness. Output
  perintah dipotong (12k karakter/stream, 1.8k/perintah di bukti).
- **Belum ada paralelisasi.** Task dijalankan berurutan; `run()` satu task per
  panggilan.
- **Reviewer kadang perlu 2 percobaan.** Pada E2E, `gpt-5.6-luna` sekali
  mengembalikan JSON yang tidak terbaca (lalu berhasil pada percobaan kedua).
  Sudah ditangani `MAX_AGENT_ATTEMPTS` + fallback `REJECTED`, tapi ini menambah
  token. Belum ada instruksi ketat "JSON saja" yang lebih agresif untuk model itu.
- **Belum ada budget token/biaya.** Limitnya jumlah siklus & attempt, bukan uang.
- **`run_command` memakai shell, bukan allowlist.** Sesuai desain (coder harus
  bebas menjalankan build/test), tapi konsekuensinya perlu disadari.
- **Test live butuh kredit & router hidup.** Karena itu dipisah dan opt-in.

---

## 11. Persistence & event system (PHASE 4)

Database adalah **source of truth**. Event adalah *change feed*-nya. Dashboard
tidak pernah membaca file log.

```
OrchestratorService
   â”‚  hooks (opsional)
   â–¼
OrchestratorHooks â”€â”€â–º EventBus â”€â”€â”¬â”€â”€â–º EventRecorder â”€â”€â–º PostgreSQL
   â”‚                             â”‚        (activity_logs + proyeksi tabel)
   â”‚                             â””â”€â”€â–º EventTransport â”€â”€â–º dashboard (realtime)
   â””â”€â”€ AgentObserver â”€â”€â–º agent (tool call / file / test)
```

### Batas tanggung jawab

- **`domain/`** tidak tahu apa-apa soal database.
- **`orchestration/runner.ts`** hanya memanggil `hooks` opsional. Tanpa hook, ia
  berperilaku persis seperti sebelumnya.
- **`orchestration/persistence-hooks.ts`** satu-satunya tempat yang tahu
  repository + bus + recorder.
- **`persistence/`** satu-satunya tempat yang menulis SQL.
- **Agent** melaporkan apa yang dilakukannya lewat `AgentObserver`; agent tidak
  pernah menyentuh bus atau database.

### Skema

| Tabel | Isi | Invarian |
|---|---|---|
| `agents` | identitas + status agent (`IDLE`/`WORKING`/`REVIEWING`/`ERROR`/`OFFLINE`) | `agent_key` unik |
| `tasks` | state task, siklus, `stop_reason`, `transition_seq` | `external_id` unik, `transition_seq` monoton |
| `task_runs` | satu eksekusi task | `run_id` unik |
| `reviews` | satu baris per review pass | `unique (task_id, cycle)` â†’ tidak bisa ditimpa |
| `activity_logs` | jurnal event + **ledger idempotency** | `event_id` primary key, `publish_seq` monoton |
| `tool_calls` | setiap tool call coder | `unique (task_id, tool_call_id)` |
| `file_changes` | metadata perubahan file (**bukan isi file**) | `unique (task_id, path)` |
| `test_results` | hasil test | partial unique: satu `test_key='final'` per task |

Migrations: `supabase/migrations/*.sql`, timestamped, idempotent, dijalankan
otomatis saat start. TIDAK butuh `pgcrypto` (`gen_random_uuid()` sudah core sejak
PG13) sehingga jalan di Postgres manapun, termasuk PGlite.

### Event flow

22 tipe event bertipe kuat (`src/events/types.ts`). Setiap event punya `id` yang
sekaligus jadi **idempotency key**.

```
orchestrator â†’ hooks.publish(TYPE, payload)
             â†’ bus.publish(event)
                 â”œâ”€â”€ listener (recorder)  â†’ activity_logs (on conflict do nothing)
                 â”‚                          + proyeksi: tool_calls/file_changes/
                 â”‚                            test_results/reviews/agents
                 â””â”€â”€ transports           â†’ InMemory / WebSocket / Supabase Realtime
```

Untuk `STATE_CHANGED` ada aturan urutan khusus: **transisi DB ditulis lebih dulu**
(di dalam satu transaksi bersama baris `activity_logs`-nya), lalu event
dipublikasikan dengan `eventId` yang **sama**, sehingga recorder mendeteksi
duplikat dan tidak menulis dua kali. Hasilnya selalu tepat satu baris
`STATE_CHANGED` yang dijamin cocok dengan `tasks.status`.

### Transports

| Transport | Kapan dipakai |
|---|---|
| `InMemoryEventTransport` | default; dashboard in-process, test |
| `WebSocketEventTransport` | queue terbatas + reconnect; butuh `connect()` dari caller |
| `SupabaseRealtimeEventTransport` | broadcast lewat channel Supabase |
| `CompositeEventTransport` | fan-out ke semuanya |

Tidak ada koneksi realtime eksternal yang dipaksa: kalau tidak dikonfigurasi,
in-memory tetap jalan. Semua transport bersifat *non-blocking* â€” sink yang mati
dilaporkan lewat `onError`, tidak pernah menghentikan task.

### Idempotency, atomicity, concurrency

- **Atomic**: status + activity log ditulis dalam satu transaksi. Satu gagal =
  keduanya rollback.
- **Idempotent**: `event_id` unik di `activity_logs`; event yang dipublikasikan
  ulang jadi no-op (`applied: false, skipped: "duplicate-event"`).
- **Concurrency**: `pg_advisory_xact_lock('task:<id>')` (lepas otomatis saat
  commit/rollback, jadi worker yang mati tidak mengunci selamanya) + compare-and-set
  lewat opsi `from`. `claim()` memastikan hanya satu worker mengambil sebuah task;
  `unique (task_id, cycle)` memastikan dua reviewer tidak memutuskan siklus yang sama.

### Recovery

- **Proses crash** â†’ `runRepository.listStale()` menemukan run yang masih
  `RUNNING` untuk ditandai `INTERRUPTED`.
- **Agent/database error** â†’ dilaporkan; task tidak pernah jadi `DONE`.
- **Event publish gagal** â†’ dilaporkan ke `onError`, task tetap jalan.
- **Jurnal gagal (fatal)** â†’ `completionBlocker` aktif; task yang sudah
  `APPROVED` **tetap tidak** menjadi `DONE` melainkan `NEEDS_HUMAN`. Ini yang
  menjamin "jangan membuat task terlihat DONE jika persistence gagal fatal".
- **Task terinterupsi** â†’ `taskRepository.release()` melepas assignment tanpa
  berpura-pura selesai.

### Keamanan data

Semua yang masuk database melewati `redact()`: key berbau kredensial
(`apiKey`, `authorization`, `token`, `password`, `cookie`, â€¦) menjadi
`[REDACTED]`, nilai yang mengandung secret di-scrub, body besar
(`content`, `raw`, â€¦) diganti `[omitted N chars]`, kedalaman/array dibatasi.
Output perintah dipotong `summarizeOutput()` (head+tail, 2000 char). **Isi file
tidak pernah disimpan** â€” hanya path, tipe perubahan, ringkasan, dan hash git bila
ada.

### Menjalankan dengan database

```bash
# .env
DATABASE_URL=postgresql://user:pass@host:5432/db   # Supabase Postgres juga bisa
DATABASE_SSL=true

npm run db:check      # skema, migrasi terpasang, jumlah baris per tabel
npm run task          # satu task, lalu periksa isi tabelnya
```

Tanpa `DATABASE_URL`, semuanya tetap berjalan seperti sebelumnya (in-memory).

### Test

- **59 integration test** berjalan di atas **PostgreSQL sungguhan** (PGlite â€”
  Postgres 18 dikompilasi ke WASM): transaksi, rollback, advisory lock, unique
  constraint, `gen_random_uuid`. Tidak ada mock database.
- Cakupan: migrasi, agent status, task persistence, transisi atomic, idempotency
  (event & event id), concurrency (claim ganda, race dengan `from`, dua reviewer
  satu siklus), event bus (ordering, listener gagal, transport gagal, replay,
  `waitFor`), transport (in-memory, WebSocket queue/reconnect, Supabase, composite),
  redaction, proyeksi tool/file/test/review, recovery, dan E2E orkestrasi penuh.


## 12. AI Team Command Center (PHASE 5)

Dashboard web untuk memonitor dan mengendalikan kedua agent. **Tidak ada data
palsu**: setiap angka berasal dari baris database.

### Stack

Next.js 15 + React 19 + TypeScript + Tailwind CSS 4, ditambahkan ke proyek yang
sudah ada. Tidak ada framework kedua dan tidak ada database kedua.

Core orchestrator tetap ESM dengan import berakhiran `.js`; `next.config.ts`
memakai `extensionAlias` sehingga Next dapat me-resolve import itu tanpa mengubah
satu baris pun di `src/`.

### Halaman

| Route | Isi |
|---|---|
| `/` | Command Center: header sistem, 2 agent card, task board, review center, live activity, form create task |
| `/tasks` | Board + tabel semua task |
| `/tasks/[id]` | Tabs: Overview Â· Timeline Â· Runs Â· Reviews Â· Tools Â· Files Â· Tests |
| `/agents` | Daftar agent |
| `/agents/[id]` | Detail agent: model, status, task, counter, activity, tool calls |
| `/activity` | Feed activity (realtime + historis) |
| `/reviews` | Review Center, append-only, semua siklus |
| `/settings` | Konfigurasi read-only; secret tidak pernah dikirim ke browser |

### API

Baca:

```
GET /api/status          GET /api/agents          GET /api/agents/:id
GET /api/tasks           GET /api/tasks/:id       GET /api/activity
GET /api/reviews         GET /api/events (SSE)    GET /api/health
GET /api/tasks/:id/activity
GET /api/tasks/:id/<runs|reviews|tool-calls|files|tests>
```

Kontrol:

```
POST /api/tasks                    POST /api/tasks/:id/start
POST /api/tasks/:id/pause          POST /api/tasks/:id/resume
POST /api/tasks/:id/cancel         POST /api/tasks/:id/retry
POST /api/tasks/:id/approve        POST /api/tasks/:id/run
```

`/run` menjalankan orchestrator sungguhan (agent + 9Router) **di dalam proses
dashboard**, memakai ulang stack persistence yang sama sehingga event-nya mengalir
ke bus yang sedang dibaca browser. Setiap action dicatat sebagai activity/event
nyata â€” tidak ada tombol yang hanya mengubah state React.

### Realtime: kenapa lewat database

Temuan penting: **orkestrator dan dashboard adalah proses terpisah.** Event bus
in-process tidak bisa menjembatani itu â€” event yang dipublikasikan orkestrator
tidak akan pernah terlihat dashboard.

Karena database adalah source of truth (setiap event dijurnal ke `activity_logs`
dengan `publish_seq` monoton), stream SSE membaca **jurnal**, bukan bus:

1. `hello` â€” status database + transports
2. backlog â€” 100 baris terakhir dari jurnal
3. `backlog-complete`
4. event live â€” baris dengan `publish_seq` > cursor, di-poll tiap 1s

Cursor hanya maju setelah baris benar-benar dikirim, dan client melakukan dedupe
berdasarkan event id, sehingga reconnect tidak menggandakan tampilan dan tidak ada
event yang hilang. UI tetap berfungsi saat realtime mati: semua panel membaca
database lewat REST.

`GET /api/status` melaporkan `realtime.source: "database"` dan daftar transport
yang benar-benar terpasang.

### Kontrol & keamanan

- Tombol hanya muncul untuk transisi yang memang legal pada status itu.
- `Run now` menjalankan task; `Start` hanya mengantrekannya untuk worker eksternal.
- `ROUTER_API_KEY` tidak pernah dikirim ke browser: redaksi dilakukan di recorder
  (sebelum disimpan) dan sekali lagi di boundary hub realtime.
- Tidak ada endpoint eksekusi shell dari browser.

### Menjalankan

```bash
npm run build          # build core + dashboard
npx next start -p 3100 # produksi
npx next dev -p 3100   # development
```

Dashboard membaca `PGLITE_DATA_DIR` (embedded Postgres, single-process) atau
`DATABASE_URL`.

**Catatan penting:** PGlite bersifat single-process â€” dashboard dan CLI tidak
boleh membuka direktori yang sama secara bersamaan (proses kedua akan membaca
snapshot lama, sehingga event tidak terlihat realtime). Untuk menjalankan task
dari dashboard, gunakan `POST /api/tasks/:id/run` yang berjalan di proses yang
sama. Untuk produksi multi-proses, gunakan `DATABASE_URL` ke PostgreSQL
sungguhan; desain streaming berbasis jurnal ini memang dibuat untuk itu.

 # #   1 3 .   H u m a n   C o n t r o l   &   O r c h e s t r a t i o n   R e c o v e r y   ( P H A S E   6 ) 
 

## 13. Human Control & Orchestration Recovery (PHASE 6)

Fitur yang menambahkan kemampuan kontrol loop eksekusi secara *cooperative* dan *stateful recovery*.

### Worker & Orchestrator

- **SingleProcessWorker**: Implementasi worker untuk dashboard in-process yang mengeksekusi siklus orchestrator. Menggunakan *advisory lock* untuk memastikan single-execution dan state isolation.
- **Task Interrupts (Cooperative Stop)**: Pembatalan tidak mematikan Node.js melainkan memberikan sinyal (via database tabel `task_interrupts`) yang dipolling oleh worker setiap jeda aman.
  - **Pause**: Menahan siklus dan menandai status menjadi `PAUSED`.
  - **Cancel**: Menghentikan eksekusi secara permanen menjadi `CANCELLED`.
  - **Resume**: Melanjutkan task `PAUSED` tanpa membuat *run row* baru karena loop dieksekusi dari state yang tersimpan.
  - **Retry**: Mengembalikan `CANCELLED`/`FAILED` menjadi `PENDING` untuk memulai *run* baru dari awal.

### Dashboard API

Setiap `POST /api/tasks/:id/<action>` memvalidasi state dan berinteraksi secara aman dengan worker:
- **Idempotency Guard**: Double `start` diblokir dengan 409 Conflict.
- **Graceful Unwind**: `cancel` dan `pause` saat worker berjalan akan ditunggu sampai siklus mencapai *safe point*, mencegah data parsial.

### Crash Recovery & Stale Detection

Worker mengirim *heartbeat* secara periodik. Jika proses crash atau terbunuh:
1. Endpoint `GET /api/recovery` (atau script `recover`) memindai `runs` yang masih `RUNNING` tapi heartbeat-nya kadaluarsa (> 120s).
2. Task dikembalikan ke status aman (`NEEDS_HUMAN`) dengan keterangan `INTERRUPTED`.
3. Agent dibebaskan (`IDLE`), sehingga orkestrasi tidak *deadlock*.
