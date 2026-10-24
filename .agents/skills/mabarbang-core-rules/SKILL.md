---
name: mabarbang-core-rules
description: Aturan mutlak dan daftar fitur inti MabarBang yang DILARANG KERAS diubah, dihapus, atau dimatikan tanpa izin eksplisit user.
---

# ⚠️ ATURAN MUTLAK & FITUR INTI MABARBANG (JANGAN DIUBAH-UBAH!)

Dokumen ini adalah pedoman permanen untuk semua agen AI yang bekerja di repositori **MabarBang (geochat)**.
**PERINGATAN:** DILARANG KERAS menghapus, mematikan, atau "merapikan/refactor" fitur-fitur penting di bawah ini yang sudah berjalan normal!

---

## 1. Silent Background Auto-Updater (STARTUP) - DILARANG DIHAPUS
- **Lokasi:** `src/server/index.ts` pada blok `(async () => { ... const update = await checkForAppUpdates() ... })()`.
- **Fungsi:** 
  Begitu MabarBang dibuka dan ada versi baru di GitHub Releases, aplikasi **WAJIB otomatis mengunduh installer `.exe` di background** dan menjalankannya dengan parameter:
  `cmd.exe /c start /wait "" "<installer>" /VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS && del /f /q "<installer>"`
- **Anti-Sampah (Zero Junk Files):**
  - SEBELUM mengunduh, panggil `cleanOldTempInstallers()` untuk menghapus semua file installer lama di `%TEMP%`.
  - SETELAH instalasi selesai, file installer di `%TEMP%` **WAJIB langsung terhapus** (`del /f /q`).
- **CATATAN SEJARAH:** Fitur ini sempat dihapus pada commit `39d827e` dengan dalih security audit, yang membuat user marah besar karena auto-update mati. **JANGAN PERNAH MENGULANGI KESALAHAN INI!**

---

## 2. 1-Click Update & Restart Endpoint (DASHBOARD)
- **Lokasi:** `src/server/index.ts` -> endpoint `POST /api/app/update-and-restart`.
- **Frontend:** Tombol "⚡ Pasang Update Sekarang" di `public/dashboard/index.html`.
- **Fungsi:** Menyediakan alternatif update 1-klik langsung dari browser jika streamer ingin update manual saat server sedang berjalan.
- **Pembersihan:** File installer juga wajib otomatis dibersihkan dan port 5050 ditutup secara bersih sebelum proses keluar (`process.exit(0)`).

---

## 3. Keamanan Kredensial Supabase & Fallback Obfuscation
- **Lokasi:** `src/server/embeddedTemplates.ts`, `scripts/bundle-server.mjs`, `scripts/build-standalone.mjs`.
- **Aturan:**
  1. `.env` eksternal selalu dibaca dari `candidateEnvPaths` (`process.cwd()` dan `path.dirname(process.execPath)`).
  2. Jika `.env` tidak ada (misal di PC streamer biasa), server memakai fallback string terenkripsi XOR-Base64 (`embeddedSecUrl`, `embeddedSecKey`).
  3. Skrip build (`bundle-server.mjs` dan `build-standalone.mjs`) **HARUS mempertahankan** kredensial terenkripsi yang sudah ada jika build dijalankan di lingkungan tanpa file `.env` (seperti GitHub Actions runner).
  4. **JANGAN PERNAH** menaruh kredensial Supabase mentah (plain text) ke dalam git.

---

## 4. Perlindungan Kuota & Efisiensi Supabase
- **Lokasi:** `src/server/index.ts` dan `src/server/supabase.ts`.
- **Aturan:**
  1. **JANGAN** memanggil Supabase di setiap ronde (`finishRound`). Itu membuat kuota habis dan spam database.
  2. Supabase **HANYA** dipanggil 1 kali saat game benar-benar berakhir (`finishGame`), dan dibatasi hanya Top 100 pemain (`finalLb.slice(0, 100)`).
  3. Session ID deduplikasi harus dijaga dengan `savedSessions = new Set<string>()`.

---

## 5. Hubungan dengan File PC User
- Agen **DILARANG** menjalankan script atau command yang mengutak-atik direktori pribadi user (seperti `AppData\Roaming`, `%LOCALAPPDATA%`, file instalasi PC, registry) secara sepihak.
- Fokus kerja agen adalah **KODE REPOSITORI / SERVER (`src/`, `scripts/`, `public/`)**, bukan file PC lokal user.

---

## 6. Golden Rule: "If It's Working, DO NOT TOUCH IT"
- Jangan pernah menghapus fitur hanya karena ingin "merapikan kode" (*code cleanup*) atau "audit keamanan" (*security refactoring*) tanpa persetujuan eksplisit dari user.
- Jika user meminta penambahan fitur A, **HANYA** tambahkan fitur A. Jangan utak-atik atau buang fitur B yang sudah berjalan dengan benar.
