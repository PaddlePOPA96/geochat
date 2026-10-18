<div align="center">
  <h1>🎮 MabarBang</h1>
  <p><b>Server & Bot GeoGuessr untuk Komunitas Mabar Streamer</b></p>
  <p><i>kikobooo x arvana prod</i></p>
</div>

---

## 📌 Tentang MabarBang

**MabarBang** adalah aplikasi lokal server & bridge bot untuk mengintegrasikan tebakan penonton/chat langsung dari **YouTube Live** dan **TikTok LIVE** ke dalam permainan **GeoGuessr** secara real-time. Viewer cukup mengetik `!g <tebakan>` di live chat untuk berpartisipasi.

- **Port Default:** `5050`
- **Platform:** Windows & macOS

---

## 📥 Download & Install (Rekomendasi Pemain / Streamer)

Tidak perlu setup koding atau Node.js! Anda cukup mengunduh installer resmi dari halaman Releases:

👉 **[Download MabarBang Versi Terbaru (GitHub Releases)](https://github.com/PaddlePOPA96/geochat/releases/latest)**

1. Buka link rilis di atas, lalu unduh file installer:
   - **Windows:** Unduh file `MabarBang-x.x.x.Setup.exe` (atau zip rilis jika tersedia).
2. Jalankan file `.exe` hasil unduhan untuk menginstall ke komputer Anda.
3. Setelah instalasi selesai, shortcut desktop **MabarBang** siap digunakan!

---

## 🚀 Cara Menjalankan (Pengguna Lokal / Portable)

### 1. Windows

- **Menggunakan Launcher / Batch File:**
  Cukup klik dua kali `run.bat` atau jalankan via terminal:
  ```cmd
  run.bat
  ```
  *(Otomatis membuka blokir file internet jika diperlukan dan menjalankan `MabarBang.exe`)*

- **Menggunakan Executable Langsung:**
  Jalankan `MabarBang.exe` yang ada di folder root atau di dalam folder `bin/mabarbang/`.

---

### 2. macOS

- Klik dua kali file `MabarBang.command` atau jalankan via Terminal:
  ```bash
  chmod +x MabarBang.command
  ./MabarBang.command
  ```
  *(Pastikan Node.js sudah terinstal di Mac Anda)*

---

### 3. Mode Development / Dari Source Code

Jika ingin menjalankan atau mengembangkan langsung menggunakan Node.js:

```bash
# Jalankan server
npm run server
# atau
npm start

# Mode development Electron
npm run dev

# Bundle server
npm run bundle

# Build Standalone Executable (Windows)
npm run build:exe
```

---

## 🧩 Userscript (Browser Extension)

Untuk menghubungkan website GeoGuessr dengan MabarBang:
1. Pasang ekstensi Tampermonkey / Violentmonkey di browser.
2. Pasang userscript yang ada di folder [`userscript/chatguessr-connector.user.js`](./userscript/chatguessr-connector.user.js).
3. Pastikan server MabarBang sudah berjalan di port `5050`.

---

## 📄 Lisensi

Proyek ini berbasis pada ChatGuessr dan didistribusikan di bawah lisensi [MIT License](./LICENSE).
