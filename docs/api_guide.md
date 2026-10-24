# BionPay V1 Integration Guide & SDK Documentation

Selamat datang di Panduan Integrasi Resmi **BionPay Multi-Application Payment Hub**.
Dokumen ini berisi panduan teknis lengkap untuk mengintegrasikan gateway pembayaran BionPay ke website dan aplikasi eksternal (Next.js, Laravel/PHP, WooCommerce, dan Node.js).

---

## 1. Konsep & Arsitektur

BionPay v1 menerapkan arsitektur **Multi-Tenant Integration Platform**:
- **Application ID (`app_...`)**: Setiap website/toko online yang terintegrasi memiliki identitas terpisah dengan isolasi transaksi penuh.
- **API Credentials**: Kunci otorisasi terpisah untuk lingkungan `LIVE` (`bp_live_...`) dan `SANDBOX` (`bp_test_...`).
- **Webhook Signing Secret (`whsec_...`)**: Kunci rahasia khusus per aplikasi yang digunakan untuk menandatangani payload webhook menggunakan algoritma **HMAC-SHA256**. Kunci ini **terpisah** dari API Key.
- **Idempotency Key**: Mendukung header `Idempotency-Key: <unique_string>` pada pembuatan pembayaran untuk mencegah duplikasi tagihan akibat *network timeout* atau pengiriman ulang.

---

## 2. Autentikasi API

Setiap panggilan ke REST API V1 wajib menyertakan header:
```http
X-API-Key: bp_live_xxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```
atau menggunakan format Bearer:
```http
Authorization: Bearer bp_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 3. Contoh Integrasi Node.js / Next.js (Server-Side)

### A. Membuat Pembayaran (Server Action / API Route)
```javascript
// app/api/checkout/route.js (Next.js App Router)
import { NextResponse } from 'next/server';

export async function POST(req) {
    const { orderId, amount, customerName, customerEmail } = await req.json();

    const response = await fetch('http://localhost:3000/v1/payments', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': process.env.BIONPAY_API_KEY,
            'Idempotency-Key': `checkout_${orderId}`
        },
        body: JSON.stringify({
            order_id: orderId,
            amount: amount,
            customer_name: customerName,
            customer_email: customerEmail,
            description: `Order #${orderId}`,
            provider: 'AUTO',
            expires_in_minutes: 15,
            callback_url: 'https://toko-anda.com/api/webhooks/bionpay',
            return_url: `https://toko-anda.com/orders/${orderId}/status`
        })
    });

    const json = await response.json();
    if (!response.ok || !json.success) {
        return NextResponse.json({ error: json.error?.message || 'Gagal membuat pembayaran' }, { status: 400 });
    }

    return NextResponse.json({
        payment_id: json.data.id,
        checkout_url: json.data.checkout_url,
        qris_image_url: json.data.qris_image_url,
        expires_at: json.data.expires_at
    });
}
```

### B. Verifikasi Webhook Signature (Next.js)
```javascript
// app/api/webhooks/bionpay/route.js
import { NextResponse } from 'next/server';
import crypto from 'crypto';

export async function POST(req) {
    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-bionpay-signature'); // e.g. sha256=abcdef...
    const timestampHeader = req.headers.get('x-bionpay-timestamp');
    const eventId = req.headers.get('x-bionpay-event-id');

    if (!signatureHeader || !timestampHeader) {
        return NextResponse.json({ error: 'Missing signature headers' }, { status: 401 });
    }

    // 1. Replay Protection: Tolak request lebih tua dari 5 menit (300 detik)
    const nowUnix = Math.floor(Date.now() / 1000);
    if (Math.abs(nowUnix - parseInt(timestampHeader, 10)) > 300) {
        return NextResponse.json({ error: 'Webhook timestamp expired (replay attack protection)' }, { status: 401 });
    }

    // 2. Verifikasi HMAC-SHA256 Signature
    const secret = process.env.BIONPAY_WEBHOOK_SECRET; // whsec_...
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${timestampHeader}.${rawBody}`)
        .digest('hex');

    const receivedSignature = signatureHeader.replace(/^sha256=/, '');

    const isValid = crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(receivedSignature)
    );

    if (!isValid) {
        return NextResponse.json({ error: 'Invalid HMAC signature' }, { status: 401 });
    }

    // 3. Tangani Event Terverifikasi
    const event = JSON.parse(rawBody);

    if (event.event === 'payment.success') {
        const payment = event.data;
        console.log(`✅ Order ${payment.order_id} LUNAS sebesar Rp ${payment.amount} via ${payment.payer_issuer}!`);
        // Update database toko Anda: status = PAID
    } else if (event.event === 'payment.review_required') {
        console.warn(`⚠️ Order ${event.data.order_id} memerlukan review manual operator.`);
    }

    return NextResponse.json({ received: true });
}
```

---

## 4. Contoh Integrasi Laravel / PHP

### A. Membuat Tagihan Pembayaran
```php
<?php
namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

class BionPayCheckoutController extends Controller
{
    public function createPayment(Request $request)
    {
        $orderId = 'ORD-' . strtoupper(Str::random(8));
        $amount = 75000;

        $response = Http::withHeaders([
            'X-API-Key' => config('services.bionpay.api_key'),
            'Idempotency-Key' => 'laravel_' . $orderId,
            'Content-Type' => 'application/json',
        ])->post(config('services.bionpay.base_url') . '/v1/payments', [
            'order_id' => $orderId,
            'amount' => $amount,
            'customer_name' => 'Budi Santoso',
            'customer_email' => 'budi@example.com',
            'description' => 'Pembayaran Tiket Workshop',
            'provider' => 'AUTO',
            'expires_in_minutes' => 15,
            'callback_url' => route('bionpay.webhook'),
            'return_url' => route('checkout.success', ['order' => $orderId])
        ]);

        if ($response->successful()) {
            $data = $response->json('data');
            return redirect($data['checkout_url']);
        }

        return back()->withErrors(['msg' => 'Gagal membuat tagihan QRIS']);
    }
}
```

### B. Verifikasi Webhook Signature (Laravel Middleware / Controller)
```php
<?php
namespace App\Http\Controllers;

use Illuminate\Http\Request;

class BionPayWebhookController extends Controller
{
    public function handle(Request $request)
    {
        $rawBody = $request->getContent();
        $signatureHeader = $request->header('X-BionPay-Signature');
        $timestampHeader = $request->header('X-BionPay-Timestamp');

        if (!$signatureHeader || !$timestampHeader) {
            return response()->json(['error' => 'Header tanda tangan hilang'], 401);
        }

        // 1. Replay Protection (maksimal toleransi 300 detik)
        if (abs(time() - (int)$timestampHeader) > 300) {
            return response()->json(['error' => 'Waktu request kadaluarsa'], 401);
        }

        // 2. Verifikasi HMAC-SHA256
        $secret = config('services.bionpay.webhook_secret');
        $expectedSignature = hash_hmac('sha256', "{$timestampHeader}.{$rawBody}", $secret);
        $receivedSignature = str_replace('sha256=', '', $signatureHeader);

        if (!hash_equals($expectedSignature, $receivedSignature)) {
            return response()->json(['error' => 'Tanda tangan tidak valid'], 401);
        }

        $payload = json_decode($rawBody, true);
        $eventType = $payload['event'] ?? '';

        if ($eventType === 'payment.success') {
            $data = $payload['data'];
            // Tandai pesanan sebagai lunas di database Laravel
            // Order::where('order_number', $data['order_id'])->update(['status' => 'PAID']);
        }

        return response()->json(['status' => 'success']);
    }
}
```

---

## 5. Panduan Modul Plugin WooCommerce (WordPress)

BionPay dapat dihubungkan ke toko online WooCommerce dengan membuat plugin kustom:
1. Daftarkan gateway di `woocommerce_payment_gateways` filter: `WC_Gateway_BionPay`.
2. Pada method `process_payment($order_id)`:
   - Ambil total order: `$order->get_total()`.
   - Lakukan HTTP POST ke `/v1/payments` dengan `order_id = $order->get_id()`.
   - Dapatkan `checkout_url` dari response BionPay.
   - Return array: `['result' => 'success', 'redirect' => $data['checkout_url']]`.
3. Pada listener endpoint webhook WooCommerce (`/?wc-api=wc_gateway_bionpay`):
   - Verifikasi header `X-BionPay-Signature` dan `X-BionPay-Timestamp` sesuai algoritma HMAC di atas.
   - Panggil `$order->payment_complete($payment_id)` dan tambahkan order note: `"Pembayaran QRIS lunas via BionPay ({$data['payer_issuer']})"`.
