# BionPay Unified Gateway

<p align="center">
  <img src="https://img.shields.io/badge/BionPay-v2.0.0--Hub-00AED9?style=for-the-badge&logoColor=white" alt="BionPay Version" />
  <img src="https://img.shields.io/badge/Node.js-18.x%20%7C%2020.x%20%7C%2022.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Dual_Provider-GoPay_%2B_ShopeePay-EE4D2D?style=for-the-badge" alt="Dual Provider" />
  <img src="https://img.shields.io/badge/QRIS-EMVCo%20Dynamic-10B981?style=for-the-badge" alt="EMVCo Dynamic QRIS" />
  <img src="https://img.shields.io/badge/Database-PostgreSQL%20%2B%20ACID-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License" />
</p>

<p align="center">
  <strong>Multi-Application Payment Integration Hub & Unified Payment Gateway.</strong><br>
  Platform integrasi pembayaran mandiri (self-hosted) untuk menghubungkan berbagai website dan aplikasi eksternal ke gateway QRIS dinamis GoPay & ShopeePay dengan REST API v1 terstandar, signed webhook HMAC-SHA256, hosted checkout responsif, dan engine rekonsiliasi transaksional.
</p>

---

## 📑 Daftar Isi

- [Tentang BionPay](#-tentang-bionpay)
- [Fitur Utama](#-fitur-utama)
- [Arsitektur Dual-Provider](#-arsitektur-dual-provider)
- [Persyaratan Sistem](#-persyaratan-sistem)
- [Panduan Instalasi Cepat](#-panduan-instalasi-cepat)
- [Konfigurasi Lingkungan (.env)](#-konfigurasi-lingkungan-env)
- [Autentikasi Akun Merchant](#-autentikasi-akun-merchant)
  - [1. Autentikasi GoBiz (Terminal OTP)](#1-autentikasi-gobiz-terminal-otp)
  - [2. Autentikasi ShopeePay Partner](#2-autentikasi-shopeepay-partner)
- [Dokumentasi API](#-dokumentasi-api)
  - [1. Buat Sesi QRIS Dinamis (GoPay / ShopeePay / Auto)](#1-buat-sesi-qris-dinamis)
  - [2. Halaman Checkout Web Interaktif](#2-halaman-checkout-web-interaktif)
  - [3. Dapatkan Gambar QR Code Mentah](#3-dapatkan-gambar-qr-code-mentah)
  - [4. Cek Status Pembayaran (Public Polling)](#4-cek-status-pembayaran-public-polling)
  - [5. Cek Pembayaran Manual / Server-to-Server](#5-cek-pembayaran-manual--server-to-server)
  - [6. Riwayat Mutasi Gabungan (GoBiz & ShopeePay)](#6-riwayat-mutasi-gabungan)
  - [7. Sinkronisasi Manual Mutasi](#7-sinkronisasi-manual-mutasi)
  - [8. ShopeePay Specific Endpoints (Backward Compatible)](#8-shopeepay-specific-endpoints)
  - [9. Telemetri & Statistik Dashboard](#9-telemetri--statistik-dashboard)
- [Integrasi Webhook](#-integrasi-webhook)
- [Panduan Deployment Produksi](#-panduan-deployment-produksi)
- [Troubleshooting & FAQ](#-troubleshooting--faq)
- [Lisensi & Penafian](#-lisensi--penafian)

---

## 💡 Tentang BionPay

**BionPay** adalah payment gateway self-hosted open-source yang menggabungkan kemampuan **GoPay (GoBiz Merchant)** dan **ShopeePay (Shopee Partner Web)** ke dalam satu aplikasi tunggal terpadu.

BionPay membaca template QRIS statis outlet Anda, lalu secara komputasi lokal menyusunnya menjadi **QRIS Dinamis Standar EMVCo** (Tag 01 = `12`, Tag 54 = Nominal, Tag 63 = CRC16 Checksum). Ketika pembeli membayar via BCA, Mandiri, BRI, BNI, GoPay, OVO, Dana, ShopeePay, atau bank/e-wallet manapun, background worker BionPay secara real-time menangkap data settlement dari backend GoBiz dan ShopeePay, langsung memverifikasi transaksi, menandai sesi lunas, dan mengirimkan webhook notifikasi ke server toko Anda.

---

## ✨ Fitur Utama

### 🌟 Platform Hub & Multi-Website (v2.0 Upgrade)
- 🌐 **Multi-Application Tenant Hub:** Daftarkan banyak website dan platform eksternal ke satu server BionPay dengan isolasi data penuh berdasarkan `application_id`.
- 🔐 **Scoped API Credentials:** Generate API Key live (`bp_live_...`) dan sandbox (`bp_test_...`) per website dengan permission scope granular (`payments:read`, `payments:write`, `admin`) dan fitur rotasi/revokasi instan.
- 🚀 **REST API V1 Terstandar:** Endpoint pembayaran modern (`POST /v1/payments`, `GET /v1/payments/:id`, `POST /v1/payments/:id/cancel`, `GET /v1/health`) dengan format respon seragam, error code terstandar, dan dukungan wajib header `Idempotency-Key`.
- 🔏 **Enterprise Signed Webhook Engine:** Signing secret unik per aplikasi (`whsec_...`), tanda tangan HMAC-SHA256 (`X-BionPay-Signature`), authenticated timestamp, event ID, antrean retry eksponensial (5x backoff), replay attack protection, dan SSRF guard.
- 🎨 **Hosted Checkout Responsif:** Halaman bayar interaktif (`/checkout/:id`) berpenampilan modern (monochrome anti-slop) dengan branding logo dan nama aplikasi toko, timer countdown, dynamic QRIS, dan proteksi secret di frontend.
- ⚖️ **Engine Rekonsiliasi & Ambiguity Guard:** Transaksional ACID (PostgreSQL + persistent engine), proteksi double-claim unik, penanganan transaksi identik dengan status `REVIEW_REQUIRED`, dan panel review manual operator.
- 📖 **OpenAPI 3.0 & Interactive Swagger UI:** Akses spesifikasi lengkap di [`/docs`](http://localhost:3000/docs) serta panduan integrasi praktis di [`docs/api_guide.md`](docs/api_guide.md) untuk Next.js, Laravel/PHP, dan WooCommerce.

### ⚡ Fitur Inti Gateway
- ⚡ **Dual-Provider EMVCo Engine:** Buat QRIS Dinamis menggunakan template GoPay atau ShopeePay dengan parser Tag-Length-Value (TLV) presisi tinggi dan verifikasi checksum CRC16.
- 🔄 **Unified Settlement Auto-Matcher:** Background worker memeriksa transaksi pending setiap 10 detik ke GoBiz dan ShopeePay secara otomatis tanpa perlu campur tangan manual.
- 🛡️ **Anti Double-Claim Scope (`trx_id`):** Setiap transaksi memiliki scope ID unik sehingga jika terdapat dua pembeli dengan nominal yang sama dalam waktu berdekatan, transaksi tidak akan tertukar atau saling klaim.
- 🖥️ **Developer & Merchant Console:** Dashboard antarmuka web modern ([http://localhost:3000/](http://localhost:3000/)) dilengkapi:
  - Dual status pills (GoPay online & ShopeePay token status).
  - Generator QRIS dengan pemilih provider (`AUTO`, `GOPAY`, `SHOPEEPAY`).
  - Pratinjau QR interaktif & simulasi bayar pengujian.
  - Tabel mutasi masuk real-time dengan badge provider.
  - Tab manajemen Integrasi & Website Hub.
  - Tab Audit & Rekonsiliasi Settlement Unmatched.
  - Tab manajemen token ShopeePay langsung dari UI.
  - API Playground console & Live activity logs.
- 🔑 **Set-and-Forget GoBiz Auth:** Autentikasi terminal satu kali via SMS/WA (`node login.js`). Sistem secara otomatis memperbarui (*auto-refresh*) access token setiap 6 jam di background.
- 🛒 **ShopeePay Partner Integration:** Dukungan token partner web ShopeePay dengan endpoint update token instan (`POST /update-token`), cek status validitas, dan rotasi User-Agent.
- 📲 **Telegram Alert Webhook:** Notifikasi otomatis ke Telegram saat token ShopeePay kadaluarsa atau mendekati masa aktif habis.
- 🧪 **Sandbox Simulation Mode:** Dilengkapi mode pengujian lokal (`SANDBOX_MODE=true`) untuk menguji integrasi frontend/backend tanpa menggunakan uang riil.

---

## 🔒 Arsitektur Dual-Provider

```
                           [ Pembeli / Customer ] 
                                      │  (Scan Dynamic QRIS)
                                      ▼
            [ Jaringan QRIS Nasional / Bank Indonesia / ASPI ]
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
      [ GoBiz / GoPay Merchant API ]           [ ShopeePay Partner Web API ]
                   │                                     │
                   └──────────────────┬──────────────────┘
                                      ▼
                           [ BionPay Unified Gateway ]
                                      │
                   ├──────────────────┼──────────────────┤
                   ▼                  ▼                  ▼
             [ Auto Match ]     [ State Store ]    [ Webhook Dispatch ]
            (Cek CRC16/Nominal)  (Anti Double-Claim)  (HMAC-SHA256 Signature)
                                                         │
                                                         ▼
                                               [ Backend Toko Anda ]
```

---

## 💻 Persyaratan Sistem

- **Node.js:** Versi 18.x, 20.x, atau 22.x LTS.
- **Sistem Operasi:** Linux (Ubuntu, Debian, CentOS, AlmaLinux), macOS, atau Windows Server.
- **Server:** VPS atau server dengan penyimpanan permanen 24/7 (RAM minimal 512MB).
- **Akun GoBiz (Opsional):** Terdaftar sebagai Merchant GoPay / GoFood aktif dengan nomor HP yang dapat menerima OTP.
- **Akun ShopeePay Partner (Opsional):** Akun ShopeePay Partner toko aktif.

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

### 4. Setup Akun Merchant
- Untuk GoPay: Jalankan `node login.js` (lihat panduan GoBiz di bawah).
- Untuk ShopeePay: Masukkan token ke `.env` atau via tab dashboard (lihat panduan ShopeePay di bawah).

### 5. Jalankan Gateway
```bash
npm start
```
Buka dashboard di browser Anda: **`http://localhost:3000/`**

---

## ⚙️ Konfigurasi Lingkungan (`.env`)

```ini
# Server & Keamanan
PORT=3000
API_KEY=bionpay_secret_api_key_2026
SANDBOX_MODE=false

# Provider GoPay / GoBiz
QRIS_STATIC=00020101021126610014ID.GO-JEK.WWW...
GOPAY_MERCHANT_ID=
GOPAY_MERCHANT_NAME=Nama Toko Anda
GOPAY_MERCHANT_CITY=Jakarta

# Provider ShopeePay Partner
SHOPEE_TOKEN=B:v1:eyJhbGciOi...
SHOPEE_QRIS_STATIC=

# Notifikasi Telegram (Opsional)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

| Variabel | Default | Keterangan |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port listen server gateway |
| `API_KEY` | `YOUR_API_KEY` | Kunci otorisasi rahasia untuk endpoint API |
| `SANDBOX_MODE` | `false` | Set `true` untuk mode simulasi pengujian tanpa uang riil |
| `QRIS_STATIC` | - | String QRIS statis outlet GoPay / GoBiz |
| `GOPAY_MERCHANT_NAME` | `TOKO CONTOH`| Nama toko yang tercantum di header QRIS GoPay |
| `SHOPEE_TOKEN` | - | Token merchant web ShopeePay (diawali `B:...`) |
| `SHOPEE_QRIS_STATIC` | - | String QRIS statis outlet ShopeePay (opsional) |
| `TELEGRAM_BOT_TOKEN` | - | Token Bot Telegram untuk alert token expired |
| `TELEGRAM_CHAT_ID` | - | Chat ID Telegram penerima alert |

---

## 🔐 Autentikasi Akun Merchant

### 1. Autentikasi GoBiz (Terminal OTP)
```bash
node login.js
```
1. Masukkan nomor HP GoBiz Anda (format: `08xxxxxxxxxx`).
2. Masukkan 4 digit kode OTP yang dikirimkan via SMS atau WhatsApp.
3. Setelah sukses, token tersimpan di `.GOPAY_SESI_JANGAN_DIHAPUS.json` dan server me-refresh sesi secara otomatis setiap 6 jam.

### 2. Autentikasi ShopeePay Partner
1. Buka browser di komputer, login ke [shopeepay.shopee.co.id/merchant/](https://shopeepay.shopee.co.id/merchant/).
2. Tekan `F12` untuk membuka Developer Tools, pilih tab **Network**.
3. Buka menu **Transaksi** di merchant web ShopeePay, lalu cari request yang bernama `get-transaction-list`.
4. Klik request tersebut, buka tab **Payload**, salin isi properti `metadata.token` (string panjang diawali `B:...`).
5. Tempel token ke file `.env` pada variabel `SHOPEE_TOKEN` atau masukkan langsung melalui Dashboard BionPay pada tab **ShopeePay Partner**.

---

## 📡 Dokumentasi API

### 1. Buat Sesi QRIS Dinamis
Membuat tagihan QRIS baru dengan nominal dan provider yang ditentukan.

- **Endpoint:** `POST /create-qris` (atau alias `POST /api/qris/create`)
- **Headers:** `x-api-key: YOUR_API_KEY`, `Content-Type: application/json`
- **Body:**
```json
{
  "amount": 25000,
  "order_id": "INV-2026-001",
  "provider": "AUTO",
  "callback_url": "https://toko-anda.com/webhook",
  "return_url": "https://toko-anda.com/checkout/finish"
}
```
*Catatan:* Pilihan `provider`: `AUTO` (default), `GOPAY`, atau `SHOPEEPAY`.

- **Response Sukses (200 OK):**
```json
{
  "success": true,
  "message": "Dynamic QRIS generated successfully",
  "data": {
    "qris_id": "8f2a1b9c",
    "trx_id": "TRX-8F2A1B9C",
    "order_id": "INV-2026-001",
    "provider": "GOPAY",
    "amount": 25000,
    "qris_code": "00020101021226610014...5405250005802ID5914...6304C1A8",
    "qris_url": "http://localhost:3000/qr/8f2a1b9c",
    "qr_image_url": "http://localhost:3000/qr/8f2a1b9c/image.png",
    "status": "PENDING",
    "expires_at": 1729081200000
  }
}
```

---

### 2. Halaman Checkout Web Interaktif
Halaman responsif ramah pengguna untuk pelanggan menyelesaikan pembayaran QRIS.
- **URL:** `GET /qr/:qrisId`
- **Fitur:** Hitung mundur kadaluarsa (15 menit), tombol verifikasi instan, salin string QRIS, dan tombol buka aplikasi e-wallet.

---

### 3. Dapatkan Gambar QR Code Mentah
Menghasilkan gambar QR code format PNG secara dinamis.
- **URL:** `GET /qr/:qrisId/image.png`
- **Query Opsional:** `?size=400`
- **Response:** `image/png`

---

### 4. Cek Status Pembayaran (Public Polling)
Digunakan oleh frontend/checkout untuk memeriksa apakah sesi QRIS sudah dibayar.
- **Endpoint:** `GET /api/qr-status/:qrisId`
- **Response:**
```json
{
  "success": true,
  "status": "PAID",
  "paid": true,
  "transaction": {
    "payer_issuer": "ShopeePay / BCA",
    "amount": 25000,
    "paid_at": 1729080645000
  }
}
```

---

### 5. Cek Pembayaran Manual / Server-to-Server
Memeriksa mutasi masuk secara langsung berdasarkan nominal atau ID sesi.

- **Endpoint:** `GET /check-payment`
- **Headers:** `x-api-key: YOUR_API_KEY` (atau query `?api_key=...`)
- **Query Parameters:**
  - `amount`: Nominal pembayaran (contoh: `25000`)
  - `provider`: `GOPAY` | `SHOPEEPAY` | `AUTO` (opsional)
  - `start_time`: Timestamp batas awal pencarian (opsional)
  - `scope_id`: TRX-ID sesi untuk anti double-claim (opsional)
- **Response:**
```json
{
  "status": true,
  "message": "Payment verified successfully",
  "data": {
    "amount": 25000,
    "order_id": "SPP10294829",
    "issuer": "SHOPEEPAY",
    "provider": "SHOPEEPAY",
    "transaction_id": "SPP-TX-9921",
    "claimed": true
  }
}
```

---

### 6. Riwayat Mutasi Gabungan
Melihat daftar mutasi uang masuk dari GoBiz dan ShopeePay.
- **Endpoint:** `GET /transactions`
- **Headers:** `x-api-key: YOUR_API_KEY`
- **Query Parameters:** `?days=1` (1, 7, atau 30 hari)
- **Response:**
```json
{
  "status": true,
  "provider": "ALL",
  "total": 4,
  "data": [
    {
      "id": "GOBIZ-TX-01",
      "provider": "GOPAY",
      "amount": 50000,
      "issuer": "BCA",
      "status": "SETTLEMENT",
      "time": "2026-10-22T10:15:00.000Z"
    },
    {
      "id": "SHOPEE-TX-02",
      "provider": "SHOPEEPAY",
      "amount": 25000,
      "issuer": "ShopeePay",
      "status": "SETTLEMENT",
      "time": "2026-10-22T10:18:22.000Z"
    }
  ]
}
```

---

### 7. Sinkronisasi Manual Mutasi
Memaksa gateway menarik mutasi terbaru dari GoBiz dan ShopeePay sekaligus.
- **Endpoint:** `POST /api/sync-mutations`
- **Headers:** `x-api-key: YOUR_API_KEY`
- **Response:**
```json
{
  "success": true,
  "mutations_count": 8,
  "providers": ["GOPAY", "SHOPEEPAY"]
}
```

---

### 8. ShopeePay Specific Endpoints

Endpoint khusus kompatibilitas ShopeePay Partner:

#### A. Perbarui Token ShopeePay
- **Endpoint:** `POST /update-token`
- **Headers:** `x-api-key: YOUR_API_KEY`, `Content-Type: application/json`
- **Body:** `{"token": "B:v1:eyJhbGciOi..."}`
- **Response:**
```json
{
  "status": true,
  "message": "ShopeePay token updated and verified successfully",
  "data": {
    "merchant_name": "Toko Berkah Shopee",
    "expiry": "2026-11-20T23:59:59.000Z"
  }
}
```

#### B. Cek Status Token ShopeePay
- **Endpoint:** `GET /token-status`
- **Headers:** `x-api-key: YOUR_API_KEY`
- **Response:**
```json
{
  "status": true,
  "message": "Token is active and valid",
  "data": {
    "valid": true,
    "merchant_name": "Toko Berkah Shopee",
    "expiry": "2026-11-20T23:59:59.000Z"
  }
}
```

#### C. Mutasi Khusus ShopeePay
- **Endpoint:** `GET /shopee/transactions`
- **Headers:** `x-api-key: YOUR_API_KEY`

---

### 9. Telemetri & Statistik Dashboard
- **Endpoint:** `GET /api/dashboard/stats`
- **Headers:** `x-api-key: YOUR_API_KEY`
- **Response:** Mengembalikan total sesi QRIS, total lunas, volume omset, log audit terbaru, status sesi GoPay, dan status token ShopeePay.

---

## 🔔 Integrasi Webhook

Ketika pelanggan menyelesaikan pembayaran, BionPay langsung mengirimkan notifikasi HTTP POST ke `callback_url` yang Anda daftarkan saat membuat sesi QRIS.

### Header Keamanan Webhook:
```http
Content-Type: application/json
User-Agent: BionPay-Webhook-Engine/1.1
X-Gateway-Signature: c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2
```

### Format Payload Webhook:
```json
{
  "event": "payment.success",
  "qris_id": "8f2a1b9c",
  "trx_id": "TRX-8F2A1B9C",
  "order_id": "INV-2026-001",
  "provider": "SHOPEEPAY",
  "amount": 25000,
  "payer_issuer": "ShopeePay / BCA",
  "status": "PAID",
  "timestamp": 1729080645000
}
```

### Verifikasi Signature di Node.js:
```javascript
const crypto = require('crypto');

function verifyWebhook(req, secretKey) {
  const signature = req.headers['x-gateway-signature'];
  const expected = crypto
    .createHmac('sha256', secretKey)
    .update(JSON.stringify(req.body))
    .digest('hex');
  return signature === expected;
}
```

---

## 🚀 Panduan Deployment Produksi

### Opsi A: VPS Linux Menggunakan PM2 (Direkomendasikan)
```bash
# 1. Install PM2 secara global
npm install -g pm2

# 2. Masuk ke folder proyek
cd /var/www/bionpay

# 3. Jalankan aplikasi via PM2
pm2 start server.js --name "bionpay-gateway"

# 4. Simpan konfigurasi PM2 agar otomatis jalan saat server reboot
pm2 save
pm2 startup
```

### Opsi B: Docker & Docker Compose
```yaml
version: '3.8'
services:
  bionpay:
    build: .
    restart: always
    ports:
      - "3000:3000"
    volumes:
      - ./.env:/app/.env
      - ./.gateway_store.json:/app/.gateway_store.json
      - ./.GOPAY_SESI_JANGAN_DIHAPUS.json:/app/.GOPAY_SESI_JANGAN_DIHAPUS.json
```

---

## ❓ Troubleshooting & FAQ

#### 1. Mutasi sudah masuk di aplikasi bank / GoBiz tapi status belum berubah?
- Pastikan jam server Anda sinkron dengan waktu Indonesia (NTP time synchronization).
- Periksa status GoPay di dashboard; jika sesi expired, jalankan `node login.js` ulang.
- Klik tombol **Sinkronkan** pada tabel mutasi untuk memaksa penarikan mutasi settlement.

#### 2. Token ShopeePay sering expired?
- Token web ShopeePay memiliki masa aktif bergantung pada kebijakan Shopee. Pasang `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` agar gateway memberikan peringatan otomatis ke Telegram saat token mendekati masa kadaluarsa.
- Perbarui token baru kapan saja melalui tab **ShopeePay Partner** di Dashboard tanpa perlu merestart server.

---

## 📜 Lisensi & Penafian

Proyek ini dirilis di bawah lisensi [MIT](LICENSE).

**Penafian:**
BionPay adalah perangkat lunak independen dan tidak berafiliasi, disponsori, atau didukung secara resmi oleh PT Dompet Anak Bangsa (GoPay / GoTo) maupun PT AirPay International Indonesia (ShopeePay / Sea Group). Gunakan perangkat lunak ini secara bertanggung jawab untuk kebutuhan bisnis Anda sendiri.
