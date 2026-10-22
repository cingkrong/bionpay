# BionPay

<p align="center">
  <img src="https://img.shields.io/badge/BionPay-v1.0.0-00AED9?style=for-the-badge&logoColor=white" alt="BionPay Version" />
  <img src="https://img.shields.io/badge/Node.js-18.x%20%7C%2020.x%20%7C%2022.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Express-4.x-09090B?style=for-the-badge&logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/QRIS-EMVCo%20Dynamic-10B981?style=for-the-badge" alt="EMVCo Dynamic QRIS" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License" />
</p>

<p align="center">
  <strong>Self-Hosted GoPay Merchant Payment Gateway, Real-Time Settlement Sync & Dynamic QRIS Engine.</strong><br>
  Otomatisasi penerimaan pembayaran QRIS langsung ke rekening toko GoBiz tanpa biaya transaksi pihak ketiga (0% fee).
</p>

---

## 📑 Daftar Isi

- [Tentang BionPay](#-tentang-bionpay)
- [Fitur Utama](#-fitur-utama)
- [Arsitektur & Keamanan](#-arsitektur--keamanan)
- [Persyaratan Sistem](#-persyaratan-sistem)
- [Panduan Instalasi Cepat](#-panduan-instalasi-cepat)
- [Konfigurasi Lingkungan (.env)](#-konfigurasi-lingkungan-env)
- [Proses Login Sesi GoBiz (Terminal OTP)](#-proses-login-sesi-gobiz-terminal-otp)
- [Dokumentasi API](#-dokumentasi-api)
  - [1. Buat Sesi QRIS Dinamis](#1-buat-sesi-qris-dinamis)
  - [2. Halaman Checkout Web Interaktif](#2-halaman-checkout-web-interaktif)
  - [3. Dapatkan Gambar QR Code Mentah](#3-dapatkan-gambar-qr-code-mentah)
  - [4. Cek Status Pembayaran (Public Polling)](#4-cek-status-pembayaran-public-polling)
  - [5. Cek Pembayaran Manual / Server-to-Server](#5-cek-pembayaran-manual--server-to-server)
  - [6. Riwayat Mutasi GoBiz Real-Time](#6-riwayat-mutasi-gobiz-real-time)
  - [7. Sinkronisasi Manual Mutasi GoBiz](#7-sinkronisasi-manual-mutasi-gobiz)
  - [8. Telemetri & Statistik Dashboard](#8-telemetri--statistik-dashboard)
- [Integrasi Webhook](#-integrasi-webhook)
- [Panduan Deployment Produksi](#-panduan-deployment-produksi)
  - [Opsi A: VPS Linux Menggunakan PM2 (Direkomendasikan)](#opsi-a-vps-linux-menggunakan-pm2-direkomendasikan)
  - [Opsi B: Docker & Docker Compose](#opsi-b-docker--docker-compose)
  - [Opsi C: Pterodactyl Panel](#opsi-c-pterodactyl-panel)
- [Troubleshooting & FAQ](#-troubleshooting--faq)
- [Lisensi & Penafian](#-lisensi--penafian)

---

## 💡 Tentang BionPay

**BionPay** adalah payment gateway self-hosted open-source yang dirancang untuk pemilik toko, merchant GoBiz, dan developer aplikasi yang ingin mengotomatiskan penerimaan pembayaran QRIS tanpa bergantung pada aggregator berbayar.

BionPay membaca data QRIS statis outlet GoBiz Anda, lalu secara komputasi lokal mengubahnya menjadi **QRIS Dinamis Standar EMVCo** (Tag 01 = `12`, Tag 54 = Nominal, Tag 63 = CRC16 Checksum). Ketika pembeli membayar via BCA, Mandiri, BRI, GoPay, OVO, Dana, ShopeePay, atau bank manapun, background worker BionPay secara real-time menangkap data settlement dari backend GoBiz merchant analytics dan langsung memverifikasi transaksi serta mengirimkan webhook ke website Anda.

---

## ✨ Fitur Utama

- ⚡ **EMVCo Dynamic QRIS Generator:** Menghasilkan kode QRIS spesifik nominal secara instan dengan parser Tag-Length-Value (TLV) presisi tinggi dan verifikasi checksum CRC16.
- 🔄 **Auto-Match Settlement Engine:** Background worker sinkronisasi mutasi otomatis memeriksa transaksi pending setiap 10 detik tanpa perlu intervensi manual.
- 🛡️ **Anti Double-Claim Scope (`trx_id`):** Setiap transaksi memiliki scope ID unik sehingga jika terdapat dua pembeli dengan nominal yang sama dalam waktu berdekatan, transaksi tidak akan tertukar atau saling klaim.
- 🖥️ **Developer & Merchant Console:** Dashboard antarmuka web modern ([http://localhost:3000/](http://localhost:3000/)) untuk memantau sesi QRIS, riwayat uang masuk real-time, status token, dan log audit.
- 📱 **Checkout Page Interaktif:** Halaman pembayaran siap pakai (`/qr/:id`) dengan hitung mundur otomatis, tombol cek manual anti-spam, dan integrasi deep link aplikasi bank.
- 🔑 **Set-and-Forget OTP Auth:** Autentikasi terminal satu kali via SMS/WA (`node login.js`). Sistem secara otomatis memperbarui (*auto-refresh*) access token setiap 6 jam di background tanpa perlu input ulang.
- 🔔 **Signed Webhook Dispatch:** Mengirimkan payload JSON yang di-hash dengan HMAC-SHA256 (`X-Gateway-Signature`) ke endpoint callback toko Anda saat pembayaran terkonfirmasi lunas.
- 🧪 **Sandbox Simulation Mode:** Dilengkapi mode pengujian lokal (`SANDBOX_MODE=true`) untuk menguji integrasi frontend/backend tanpa menggunakan uang riil.

---

## 🔒 Arsitektur & Keamanan

```
   [ Pembeli / Customer ] 
              │  (Scan QRIS Dinamis)
              ▼
   [ Bank / E-Wallet ]  ───(Jaringan QRIS Nasional)───► [ Bank Indonesia / ASPI ]
                                                                   │
                                                                   ▼
[ BionPay Gateway ] ◄───(Auto-Sync Settlement API)─── [ GoBiz / GoPay Merchant API ]
         │
         ├──────► Verifikasi CRC16 & Nominal Cocok
         ├──────► Tandai Sesi PAID & Cegah Double Claim
         └──────► Dispatch Webhook (HMAC-SHA256) ───► [ Backend Toko Anda ]
```

- **Penyimpanan Lokal & Tanpa Data Leak:** Seluruh token sesi disimpan secara terenkripsi/terisolasi di `.GOPAY_SESI_JANGAN_DIHAPUS.json` dan `.env`, tidak pernah dikirim ke pihak ketiga manapun.
- **Proteksi API Key:** Semua endpoint administratif dilindungi header `X-API-KEY` atau query `api_key`.
- **Public API Rate-Shielding:** Endpoint public frontend hanya mengembalikan status spesifik ID QRIS tanpa mengekspos data keuangan merchant secara publik.

---

## 💻 Persyaratan Sistem

- **Node.js:** Versi 18.x, 20.x, atau 22.x LTS.
- **Sistem Operasi:** Linux (Ubuntu 20.04/22.04/24.04, Debian 11/12, CentOS, AlmaLinux), macOS, atau Windows Server.
- **Server:** VPS atau server dengan penyimpanan permanen 24/7 (RAM minimal 512MB).
- **Akun GoBiz:** Terdaftar sebagai Merchant GoPay / GoFood aktif dengan nomor HP yang dapat menerima OTP.
- **QRIS Statis:** String QRIS statis outlet yang dapat disalin dari aplikasi GoBiz.

> [!CAUTION]
> **Hindari Serverless Ephemeral (Vercel, Netlify, Render Free):** Platform serverless menghancurkan file sesi (`.GOPAY_SESI_JANGAN_DIHAPUS.json`) saat container *sleep*, sehingga token akan hilang dan meminta login ulang. Gunakan VPS, Docker mandiri, atau hosting dengan persistent storage.

---

## 🛠️ Panduan Instalasi Cepat

### 1. Clone Repository
```bash
git clone https://github.com/cingkrong/bionpay.git
cd bionpay
```

### 2. Install Dependensi
```bash
npm install
```

### 3. Konfigurasi Environment File
Salin file template `.env.example` menjadi `.env`:
```bash
cp .env.example .env
```

Edit file `.env` dan masukkan konfigurasi Anda (lihat bagian [Konfigurasi Lingkungan](#-konfigurasi-lingkungan-env)).

### 4. Login Akun GoBiz (1 Kali Saja)
```bash
node login.js
```
- Masukkan nomor HP GoBiz Anda (format: `08xxxxxxxxxx`).
- Masukkan 4 digit kode OTP yang dikirimkan via SMS atau WhatsApp.
- Setelah sukses, sesi tersimpan permanen dan server akan me-refresh token secara mandiri.

### 5. Jalankan Gateway
```bash
npm start
```
Buka dashboard di browser Anda: **`http://localhost:3000/`**

---

## ⚙️ Konfigurasi Lingkungan (`.env`)

| Variabel | Tipe | Contoh / Default | Keterangan |
| :--- | :--- | :--- | :--- |
| `PORT` | Number | `3000` | Port listen server gateway |
| `API_KEY` | String | `bionpay_secret_2026` | Kunci otorisasi rahasia untuk memanggil API |
| `QRIS_STATIC` | String | `00020101021126610014...` | String QRIS statis merchant dari aplikasi GoBiz |
| `GOPAY_MERCHANT_ID` | String | `G676629960` | ID Merchant GoBiz toko Anda (opsional, auto-detect dari sesi) |
| `GOPAY_MERCHANT_NAME`| String | `Nama Toko Anda` | Nama outlet yang ditampilkan di header QRIS |
| `GOPAY_MERCHANT_CITY`| String | `Jakarta` | Kota outlet merchant |
| `SANDBOX_MODE` | Boolean| `false` | Set `true` untuk mode simulasi pengujian lokal |

---

## 🔐 Proses Login Sesi GoBiz (Terminal OTP)

Untuk mengotorisasi akses ke API GoBiz Merchant Analytics:

```
$ node login.js
=== GoBiz Merchant Terminal Authenticator ===
Masukkan Nomor HP GoBiz (contoh: 081234567890): 085119772671
Mengirimkan permintaan OTP ke server GoBiz...
OTP berhasil dikirim ke WhatsApp / SMS Anda!

Masukkan 4 Digit Kode OTP: 1234
Memverifikasi OTP dan membuat sesi permanen...
Sesi berhasil disimpan ke .GOPAY_SESI_JANGAN_DIHAPUS.json!
Nama Merchant : Bion Digital
Merchant ID   : G676629960
Sesi Siap Digunakan!
```

---

## 📡 Dokumentasi API

Seluruh endpoint privat membutuhkan autentikasi header `X-API-KEY: <API_KEY>` atau query parameter `?api_key=<API_KEY>`.

### 1. Buat Sesi QRIS Dinamis
Membuat sesi pembayaran baru dan menghasilkan payload string QRIS EMVCo beserta URL gambar.

- **Endpoint:** `POST /api/qris/create`
- **Headers:** `Content-Type: application/json`, `X-API-KEY: <API_KEY>`
- **Request Body:**
```json
{
  "amount": 10000,
  "order_id": "ORDER-99281",
  "callback_url": "https://tokosaya.com/api/payment-callback",
  "return_url": "https://tokosaya.com/checkout/success"
}
```

- **Response Sukses (`HTTP 200`):**
```json
{
  "success": true,
  "data": {
    "qris_id": "91n4sz4r",
    "trx_id": "TRX-80MHU35F",
    "order_id": "ORDER-99281",
    "amount": 10000,
    "qris_content": "00020101021226610014COM.GO-JEK.WWW...",
    "qr_url": "http://localhost:3000/qr/91n4sz4r",
    "qr_image_url": "http://localhost:3000/qr/91n4sz4r/image.png",
    "expires_at": "2026-10-22T12:00:00.000Z"
  }
}
```

---

### 2. Halaman Checkout Web Interaktif
Halaman antarmuka pembayaran siap pakai untuk diarahkan langsung ke pembeli.

- **Endpoint:** `GET /qr/:id`
- **Contoh URL:** `http://localhost:3000/qr/91n4sz4r`
- **Fitur:** Tampilan responsif mobile, hitung mundur kedaluwarsa 5 menit, instruksi pembayaran, dan auto-redirect ke `return_url` setelah lunas.

---

### 3. Dapatkan Gambar QR Code Mentah
Menghasilkan buffer gambar PNG secara langsung untuk disematkan pada tag `<img>`.

- **Endpoint:** `GET /qr/:id/image.png`
- **Response:** `image/png` (300x300px)

---

### 4. Cek Status Pembayaran (Public Polling)
Digunakan oleh frontend checkout pembeli tanpa perlu mengekspos API Key rahasia.

- **Endpoint:** `GET /api/qr-status/:id`
- **Response (`PAID`):**
```json
{
  "success": true,
  "paid": true,
  "status": "PAID",
  "transaction": {
    "transaction_id": "01a16370-ac78-7000-aa01-f4d3a38175db",
    "order_id": "QRIS-1020261022114811WzoII4suzLID",
    "amount": 10000,
    "payer_issuer": "BCA",
    "payment_type": "QRIS",
    "transaction_time": "2026-10-22T18:48:11+07:00"
  }
}
```

---

### 5. Cek Pembayaran Manual / Server-to-Server
Memeriksa apakah terdapat transaksi masuk untuk nominal tertentu sejak waktu yang ditentukan.

- **Endpoint:** `GET /check-payment` atau `POST /check-payment`
- **Headers:** `X-API-KEY: <API_KEY>`
- **Parameters / Body:**
  - `amount` (Wajib): Nominal Rupiah yang dicari (contoh: `10000`).
  - `startTime` (Opsional): Waktu awal dalam format ISO string (default: 24 jam terakhir).
  - `trx_id` (Sangat Disarankan): ID unik pembayaran untuk mengunci scope klaim.

- **Response:**
```json
{
  "success": true,
  "paid": true,
  "transaction": {
    "transaction_id": "01a16370-ac78-7000-aa01-f4d3a38175db",
    "order_id": "QRIS-1020261022114811WzoII4suzLID",
    "amount": 10000,
    "payer_issuer": "BCA",
    "payment_type": "QRIS",
    "transaction_time": "2026-10-22T18:48:11+07:00"
  }
}
```

---

### 6. Riwayat Mutasi GoBiz Real-Time
Mengambil daftar mutasi settlement asli dari backend GoBiz.

- **Endpoint:** `GET /transactions`
- **Headers:** `X-API-KEY: <API_KEY>`
- **Response:**
```json
{
  "success": true,
  "total_amount": "125500",
  "data": {
    "transactions": [
      {
        "amount": 500,
        "status": "settlement",
        "time": "2026-10-22T18:48:11+07:00",
        "issuer": "BCA",
        "order_id": "QRIS-1020261022114811WzoII4suzLID",
        "transaction_id": "01a16370-ac78-7000-aa01-f4d3a38175db"
      }
    ]
  }
}
```

---

### 7. Sinkronisasi Manual Mutasi GoBiz
Memaksa sistem melakukan refresh mutasi GoBiz seketika dan mencocokkan seluruh sesi pending.

- **Endpoint:** `POST /api/sync-mutations`
- **Response:**
```json
{
  "success": true,
  "message": "Mutasi berhasil disinkronkan langsung dari GoBiz",
  "mutations_count": 1
}
```

---

### 8. Telemetri & Statistik Dashboard
Data statistik untuk Developer Console.

- **Endpoint:** `GET /api/dashboard/stats`
- **Headers:** `X-API-KEY: <API_KEY>`
- **Response:** Mengembalikan total sesi dibuat, total pembayaran lunas, total volume Rupiah, uptime server, dan status sesi otentikasi.

---

## 🔔 Integrasi Webhook

Jika Anda mengisi parameter `callback_url` saat membuat QRIS, BionPay akan mengirimkan HTTP POST request seketika setelah pembayaran terverifikasi.

### Header Webhook:
```http
Content-Type: application/json
X-Gateway-Signature: 6e9b8f2a... (HMAC-SHA256 dari JSON Payload menggunakan API_KEY Anda)
```

### Webhook Payload:
```json
{
  "event": "payment.success",
  "qris_id": "91n4sz4r",
  "trx_id": "TRX-80MHU35F",
  "order_id": "ORDER-99281",
  "amount": 10000,
  "payer_issuer": "BCA",
  "payment_type": "QRIS",
  "transaction_time": "2026-10-22T18:48:11+07:00",
  "timestamp": 1792669774322
}
```

### Verifikasi Signature di Backend Anda (Contoh Node.js):
```javascript
const crypto = require('crypto');

app.post('/api/payment-callback', (req, res) => {
    const signature = req.headers['x-gateway-signature'];
    const calculated = crypto
        .createHmac('sha256', process.env.BIONPAY_API_KEY)
        .update(JSON.stringify(req.body))
        .digest('hex');

    if (signature !== calculated) {
        return res.status(401).send('Invalid Signature');
    }

    const { trx_id, order_id, amount, payer_issuer } = req.body;
    console.log(`Pesanan ${order_id} lunas sebesar Rp ${amount} via ${payer_issuer}!`);

    res.json({ status: 'ok' });
});
```

---

## 🚀 Panduan Deployment Produksi

### Opsi A: VPS Linux Menggunakan PM2 (Direkomendasikan)

1. Pasang Node.js & PM2:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

2. Clone repository & persiapkan file:
```bash
git clone https://github.com/cingkrong/bionpay.git /var/www/bionpay
cd /var/www/bionpay
npm install --production
cp .env.example .env
nano .env # Sesuaikan konfigurasi
```

3. Lakukan login OTP:
```bash
node login.js
```

4. Jalankan aplikasi via PM2:
```bash
pm2 start server.js --name "bionpay"
pm2 save
pm2 startup
```

---

### Opsi B: Docker & Docker Compose

Jalankan BionPay secara terisolasi menggunakan Docker:

1. Buat file `.env` dan jalankan `node login.js` secara lokal terlebih dahulu untuk menghasilkan `.GOPAY_SESI_JANGAN_DIHAPUS.json`.
2. Jalankan container:
```bash
docker-compose up -d --build
```
3. Cek log container:
```bash
docker-compose logs -f
```

---

### Opsi C: Pterodactyl Panel

1. Pilih Egg **Node.js** (Versi 18 atau 20).
2. Upload seluruh source code BionPay ke panel.
3. Di File Manager, buat `.env` dan isi variabel yang diperlukan.
4. Di menu **Startup**, pastikan Start Command adalah `npm start` atau `node server.js`.
5. Untuk login pertama kali, buka tab **Console**, ketikkan `node login.js`, lalu masukkan nomor HP dan OTP Anda.
6. Restart server pada panel.

---

## ❓ Troubleshooting & FAQ

#### 1. Pembeli sudah bayar, tetapi mutasi belum langsung masuk di dashboard?
> Backend GoBiz merchant analytics memiliki jeda perambatan jaringan perbankan (*propagation delay*) sekitar **30 hingga 90 detik** dari saat transaksi di bank pengirim sukses hingga data di-settle di server Gojek. Background worker BionPay otomatis mencocokkan pembayaran begitu data tersedia. Anda juga dapat menekan tombol **"Sinkronkan"** di dashboard untuk memicu sinkronisasi seketika.

#### 2. Apakah token sesi GoBiz akan kedaluwarsa?
> Sesi GoBiz memiliki refresh token jangka panjang. Server BionPay memiliki sistem otomatis yang memeriksa masa berlaku token dan memperbaruinya setiap 6 jam di latar belakang, sehingga Anda tidak perlu login berulang kali selama file `.GOPAY_SESI_JANGAN_DIHAPUS.json` tidak dihapus.

#### 3. Apakah nominal pembayaran yang sama oleh 2 pembeli berbeda akan saling tertukar?
> Tidak. BionPay menerapkan isolasi berbasis `trx_id`. Setiap transaksi QRIS hanya dapat diklaim satu kali oleh sesi yang memiliki ID tersebut. Transaksi yang sudah terverifikasi tidak akan dapat diklaim ulang oleh sesi lain.

---

## 📄 Lisensi & Penafian

Proyek ini dilisensikan di bawah [MIT License](LICENSE).

**Penafian:** BionPay adalah proyek independen dan tidak berafiliasi dengan PT GoTo Gojek Tokopedia Tbk atau anak perusahaannya. Seluruh merek dagang GoPay dan GoBiz adalah hak milik masing-masing pemegang merek. Gunakan software ini secara bijak sesuai dengan syarat dan ketentuan layanan yang berlaku.
