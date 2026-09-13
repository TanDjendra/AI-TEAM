# AI Team Orchestrator — panduan agent

Dokumen ini adalah instruksi untuk agent yang bekerja **di dalam repo ini**.

Sumber kebenaran: `README.md` dan `src/`.

---

## ATURAN INTI

Jangan menebak.

Periksa repository sebelum mengubah kode.

Jangan mengarang:

- endpoint API
- method SDK
- **model id**
- environment variable
- struktur data
- kemampuan provider

Verifikasi dulu ke sumber aslinya:

```bash
curl -s -H "Authorization: Bearer $ROUTER_API_KEY" "$ROUTER_BASE_URL/models"
```

---

## MODE KERJA

Kerjakan per task. Jangan mengimplementasikan seluruh proyek sekaligus.

Saat diberi TASK-XXX:

1. Baca `README.md`.
2. Baca kode terkait.
3. Identifikasi dependensi.
4. Implementasikan hanya ruang lingkup task.
5. Jalankan `npm run typecheck`.
6. Jalankan `npm test`.
7. Perbaiki masalah yang muncul.
8. Laporkan perubahan.
9. Berhenti.

Jangan lanjut otomatis ke task lain.

---

## LAPISAN

```
domain        → tidak bergantung pada apa pun
events        → domain (tipe event bertipe kuat)
providers     → domain
agents        → domain + providers + events (hanya tipe) + agent-observer
persistence   → domain + events
orchestration → domain + agents (interface) + persistence + events
```

Orchestrator **tidak boleh** mengimpor `RouterProvider`, `CoderAgent`,
`ReviewerAgent`, atau kelas repository konkret. Hanya `orchestration/container.ts`
yang memilih implementasi.

Melanggar aturan ini merusak alasan utama arsitektur ini ada.

---

## PERSISTENCE

Database adalah source of truth. Jangan pernah membaca file log untuk
merekonstruksi state.

- SQL **hanya** boleh ditulis di `src/persistence/`.
- Repository tidak boleh dipanggil dari `agents/`. Agent melaporkan lewat
  `AgentObserver`; orchestrator meneruskannya lewat `hooks`.
- Jangan membuat koneksi realtime eksternal yang wajib. Transport harus opsional.
- Semua payload yang masuk database **wajib** lewat `redact()` /
  `summarizeOutput()`. Jangan menyimpan isi file, jangan menyimpan secret.
- Transisi state + activity log harus berada dalam **satu transaksi**. Jangan
  pernah menulis keduanya terpisah.
- Event yang sama tidak boleh menghasilkan dua transisi. Gunakan `event_id`
  sebagai idempotency key.
- Jangan menandai task `DONE` kalau persistence gagal fatal. Pakai
  `completionBlocker`.

Saat menambah event type:

1. tambahkan ke `TASK_EVENT_TYPES` dan payload map-nya;
2. publikasikan dari `hooks` (bukan dari repository);
3. tambahkan proyeksi di `EventRecorder` bila perlu tabel;
4. tambahkan test.


---

## PROVIDER

Semua LLM harus lewat abstraksi `ModelProvider`.

Logika bisnis tidak boleh bergantung langsung pada:

- 9Router
- DeepSeek
- GPT
- provider apa pun di masa depan

Agent hanya menerima `ModelProvider` lewat constructor.

---

## TOOL

Tool coder harus nyata: menulis file nyata, menjalankan proses nyata, dan
mengembalikan exit code nyata.

Jangan pernah membuat tool yang mengembalikan hasil palsu, dan jangan pernah
membuat mock yang berpura-pura memanggil model pada jalur produksi.

Setiap tool yang menulis atau menjalankan sesuatu **harus** mengembalikan
`meta` terstruktur — itulah bahan verifikasi, bukan teks bebas.

---

## KONTRAK OUTPUT

`files_changed`, `tests_run`, `tests_passed` **milik harness**, bukan milik model.
Kalau menambah kapabilitas baru, pertahankan invarian ini: nilai yang dilaporkan
ke orchestrator harus berasal dari fakta yang direkam, bukan klaim model.

Menambah field kontrak baru untuk model harus disertai:

1. update di `src/domain/types.ts`
2. update di `src/agents/prompts.ts`
3. parsing di `base-agent.ts` / agent terkait
4. test

---

## TESTING

Setiap implementasi bermakna wajib punya test.

Sebelum menyatakan selesai:

- `npm run typecheck`
- `npm test`

Kalau gagal: perbaiki. Jangan sekadar melaporkan kegagalan.

Test yang butuh router hidup dan kredit **harus** masuk `tests/live/` dan
digated `RUN_LIVE=1`.

Test yang memakai model asli secara diam-diam adalah test yang buruk — ia gagal
di CI dan menghabiskan kredit tanpa diminta.

---

## KEAMANAN

- Jangan hardcode API key.
- Jangan log API key. Logger sudah men-scrub; jangan mem-bypass-nya.
- Jangan commit `.env`.
- Semua path dari model harus lewat `Workspace.resolvePath()`.

---

## ERROR

Jangan menampilkan stack trace mentah ke pengguna.

Normalisasi lewat `toRouterError()`. Klasifikasikan: retryable, non-retryable,
rate-limit, timeout, server-error, authentication, validation.

---

## RUANG LINGKUP

Jangan membuat dashboard. Jangan menambah fitur di luar task.

Kalau menemukan perbaikan untuk masa depan, catat — jangan diam-diam memperluas
ruang lingkup.

---

## LAPORAN PERUBAHAN

Setelah setiap task, laporkan:

- File dibuat
- File diubah
- File dihapus
- Test dijalankan (hasil sesungguhnya)
- Hasil typecheck/build
- Risiko yang masih ada

---

## STATUS

Tandai selesai hanya kalau acceptance criteria benar-benar terpenuhi — dengan bukti,
bukan asumsi.
