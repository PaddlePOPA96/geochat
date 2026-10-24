# ⚠️ ATURAN MUTLAK REPOSITORI MABARBANG

Dokumen ini dibaca secara otomatis oleh setiap asisten AI / Agen Antigravity.
**DILARANG KERAS MENGUBAH / MENGHAPUS FUNGSI YANG SUDAH BERJALAN BENAR!**

---

## 🛑 DAFTAR FITUR INTI YANG DILARANG DIHAPUS / DIUBAH:

### 1. Silent Background Auto-Updater (STARTUP)
- **Lokasi:** `src/server/index.ts`
- **Wajib Ada:** Saat server start dan ada versi rilis baru di GitHub, server **WAJIB mendownload installer `.exe` di background** dan menjalankannya secara silent (`/VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS`).
- **Anti-Sampah:** Panggil `cleanOldTempInstallers()` sebelum download dan hapus installer setelah selesai dipasang (`cmd /c ... && del /f /q ...`).
- **Peringatan Keras:** Fitur ini pernah terhapus di commit `39d827e` dan membuat user marah besar. Jangan pernah menghapus atau menonaktifkannya lagi!

### 2. 1-Click Update & Restart Endpoint
- **Lokasi:** `POST /api/app/update-and-restart` di `src/server/index.ts` & tombol di `public/dashboard/index.html`.
- Menyediakan cara update 1-klik dari dashboard streamer. File installer juga wajib langsung dibersihkan dari `%TEMP%`.

### 3. Kredensial Supabase Terenkripsi (Fallback)
- **Lokasi:** `src/server/embeddedTemplates.ts`, `scripts/bundle-server.mjs`, `scripts/build-standalone.mjs`.
- Biner membaca `.env` dari folder CWD & folder `.exe`. Jika tidak ada, wajib fallback ke XOR-Base64 credentials di `embeddedTemplates.ts`.
- Saat build tanpa `.env` (misal GitHub Actions runner), skrip build **WAJIB mempertahankan** kredensial terenkripsi yang sudah ada.
- Jangan pernah menyimpan kredensial Supabase mentah (plain text) ke git.

### 4. Perlindungan Kuota Supabase
- **Lokasi:** `src/server/index.ts` dan `src/server/supabase.ts`.
- JANGAN panggil Supabase tiap ronde (`finishRound`).
- HANYA simpan ke Supabase 1x saat game selesai (`finishGame`), dibatasi Top 100 pemain saja (`finalLb.slice(0, 100)`).

### 5. Batas Kerja Agen: Hanya Repositori
- Agen DILARANG mengutak-atik file pribadi / direktori instalasi di PC user (`AppData`, `%LOCALAPPDATA%`, registry).
- Fokus kerja agen adalah file repositori kode (`src/`, `public/`, `scripts/`).

### 6. Prinsip Kerja: "Jangan Sok Merapikan Kode yang Bekerja"
- Jangan refactor / hapus fitur yang sudah berfungsi hanya karena alasan estetika atau sok audit keamanan.
- Tambahkan apa yang diminta user, jangan rusak apa yang sudah berjalan.
