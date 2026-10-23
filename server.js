const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const QRCode = require('qrcode');
const sessionManager = require('./sessionManager');
const shopeeManager = require('./shopeeManager');

// Helper pembaca dinamis konfigurasi .env agar selalu sinkron tanpa perlu restart server
function getStaticQRIS(provider = 'GOPAY') {
    try {
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            const raw = fs.readFileSync(envPath, 'utf-8');
            const lines = raw.split(/\r?\n/);
            const targetKey = provider.toUpperCase() === 'SHOPEEPAY' ? 'SHOPEE_QRIS_STATIC=' : 'QRIS_STATIC=';
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith(targetKey)) {
                    const val = trimmed.substring(targetKey.length).trim();
                    if (val && !val.startsWith('#')) return val;
                }
            }
        }
    } catch (e) {}
    if (provider.toUpperCase() === 'SHOPEEPAY') {
        return process.env.SHOPEE_QRIS_STATIC || '';
    }
    return process.env.QRIS_STATIC || '';
}

function getEnvConfig() {
    let qrisStatic = getStaticQRIS('GOPAY');
    let shopeeQrisStatic = getStaticQRIS('SHOPEEPAY');
    let merchantName = process.env.GOPAY_MERCHANT_NAME;
    let merchantCity = process.env.GOPAY_MERCHANT_CITY;
    let merchantId = process.env.GOPAY_MERCHANT_ID;
    let sandbox = process.env.SANDBOX_MODE === 'true';
    let shopeeToken = shopeeManager.getShopeeToken();
    let telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    let telegramChatId = process.env.TELEGRAM_CHAT_ID;

    try {
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            const raw = fs.readFileSync(envPath, 'utf-8');
            const lines = raw.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('GOPAY_MERCHANT_NAME=')) merchantName = trimmed.substring('GOPAY_MERCHANT_NAME='.length).trim();
                if (trimmed.startsWith('GOPAY_MERCHANT_CITY=')) merchantCity = trimmed.substring('GOPAY_MERCHANT_CITY='.length).trim();
                if (trimmed.startsWith('GOPAY_MERCHANT_ID=')) merchantId = trimmed.substring('GOPAY_MERCHANT_ID='.length).trim();
                if (trimmed.startsWith('SANDBOX_MODE=')) sandbox = trimmed.substring('SANDBOX_MODE='.length).trim() === 'true';
                if (trimmed.startsWith('SHOPEE_QRIS_STATIC=')) shopeeQrisStatic = trimmed.substring('SHOPEE_QRIS_STATIC='.length).trim();
                if (trimmed.startsWith('TELEGRAM_BOT_TOKEN=')) telegramBotToken = trimmed.substring('TELEGRAM_BOT_TOKEN='.length).trim();
                if (trimmed.startsWith('TELEGRAM_CHAT_ID=')) telegramChatId = trimmed.substring('TELEGRAM_CHAT_ID='.length).trim();
            }
        }
    } catch (e) {}

    return { qrisStatic, shopeeQrisStatic, merchantName, merchantCity, merchantId, sandbox, shopeeToken, telegramBotToken, telegramChatId };
}

const PORT = process.env.PORT || 3000;
const MAX_LOGS = 100;
const CLAIMED_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 jam
const QRIS_EXPIRY_MS = 5 * 60 * 1000; // 5 menit
const GOJEK_TRANSACTIONS_URL = 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions';
const CACHE_FILE = path.join(__dirname, '.gopay_cache.json');
const STORE_FILE = path.join(__dirname, '.gateway_store.json');

// claimedTransactions: Map<txId, { qrisId: string|null, claimedAt: number }>
const claimedTransactions = new Map();
const activityLogs = [];
const qrisStore = new Map();

// Load persistent store from disk
function loadStore() {
    try {
        if (fs.existsSync(STORE_FILE)) {
            const raw = fs.readFileSync(STORE_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (data.qrisList && Array.isArray(data.qrisList)) {
                for (const item of data.qrisList) {
                    item.expiresAt = new Date(item.expiresAt);
                    item.createdAt = new Date(item.createdAt);
                    qrisStore.set(item.qrisId, item);
                }
            }
            if (data.claimed && Array.isArray(data.claimed)) {
                for (const [k, v] of data.claimed) {
                    claimedTransactions.set(k, v);
                }
            }
            logActivity('INFO', `Data store dipulihkan: ${qrisStore.size} sesi QRIS, ${claimedTransactions.size} klaim transaksi.`);
        }
    } catch (err) {
        logActivity('ERROR', 'Gagal membaca store persistensi: ' + err.message);
    }
}

// Save store to disk
function saveStore() {
    try {
        const qrisList = [];
        for (const [qrisId, val] of qrisStore.entries()) {
            qrisList.push({ qrisId, ...val });
        }
        const claimed = Array.from(claimedTransactions.entries());
        fs.writeFileSync(STORE_FILE, JSON.stringify({ qrisList, claimed }, null, 2), 'utf-8');
    } catch (err) {
        logActivity('ERROR', 'Gagal menyimpan store persistensi: ' + err.message);
    }
}

function saveCookieToFile(cookie) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ gopay_cookie: cookie }), 'utf-8');
        logActivity('INFO', 'Cookie berhasil disimpan ke ' + CACHE_FILE);
    } catch (err) {
        logActivity('ERROR', 'Gagal simpan cookie ke file: ' + err.message);
    }
}

function logActivity(type, message, details = null) {
    const timestamp = new Date().toISOString();
    const logObj = { id: Date.now() + Math.random(), timestamp, type, message, details };
    activityLogs.unshift(logObj);
    if (activityLogs.length > MAX_LOGS) {
        activityLogs.pop();
    }
    console.log(`[${timestamp}] [${type}] ${message}`);
}

// Clean up expired claimed transactions & QRIS
function cleanExpiredTransactions() {
    const now = Date.now();
    for (const [txId, claim] of claimedTransactions.entries()) {
        const claimedAt = typeof claim === 'object' ? claim.claimedAt : claim;
        if (now - claimedAt > CLAIMED_CLEANUP_INTERVAL_MS) {
            claimedTransactions.delete(txId);
        }
    }
    for (const [id, q] of qrisStore.entries()) {
        if (now > q.expiresAt.getTime() && q.status === 'PENDING') {
            q.status = 'EXPIRED';
            qrisStore.set(id, q);
        }
    }
    saveStore();
}
setInterval(cleanExpiredTransactions, 60 * 60 * 1000);

// Periodik auto-refresh session (tiap 6 jam)
async function autoRefreshSessionPeriodically() {
    try {
        const session = sessionManager.loadSession();
        if (session && session.refresh_token) {
            if (sessionManager.isExpired(session)) {
                logActivity('INFO', 'Auto Refresh: Token mendekati kedaluwarsa, memperbarui sesi...');
                await sessionManager.refreshSession();
            }
        }
    } catch (err) {
        logActivity('ERROR', `Gagal auto refresh session: ${err.message}`);
    }
}
setInterval(autoRefreshSessionPeriodically, 6 * 60 * 60 * 1000);

// Helper Konversi Nominal GoBiz API
// API Gojek merchant-analytics mengembalikan nilai gross_amount dalam satuan sen/cents (x100)
// Contoh: Rp 500 -> 50000 sen, Rp 242 -> 24200 sen, Rp 528 -> 52800 sen, Rp 25.000 -> 2500000 sen
function parseGojekAmount(raw) {
    if (!raw && raw !== 0) return 0;
    const num = typeof raw === 'number' ? raw : parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
    if (isNaN(num)) return 0;
    // Nilai dari Gojek analytics selalu dalam sen (cents), dibagi 100 untuk mendapatkan Rupiah murni
    return Math.round(num / 100);
}

// Cache Mutasi Masuk GoBiz (Real-Time Settlement Bank / E-Wallet)
let cachedMutations = [];
let lastMutationsFetch = 0;

async function getLiveGoBizMutations(force = false, rangeDays = null) {
    const now = Date.now();
    if (!force && cachedMutations.length > 0 && (now - lastMutationsFetch < 8000)) {
        return cachedMutations;
    }

    try {
        const headers = await sessionManager.getValidHeaders();
        if (!headers) return cachedMutations;

        const merchantId = getMerchantId();
        const endTime = new Date();
        const days = rangeDays ? parseInt(rangeDays, 10) : 1; // Default 1 hari (hari ini / 24 jam)
        const startTime = new Date(endTime.getTime() - days * 24 * 3600 * 1000);

        const res = await axios.get(GOJEK_TRANSACTIONS_URL, {
            headers,
            params: {
                from: 0,
                size: 100,
                statuses: 'SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND',
                payment_types: 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD',
                start_time: startTime.toISOString(),
                end_time: endTime.toISOString(),
                merchant_ids: merchantId
            },
            timeout: 8000
        });

        const raw = res.data?.transactions || res.data?.data?.transactions || [];
        cachedMutations = raw.map(tx => {
            const txId = tx.id || tx.order_id || tx.wallstreet_transaction_id;
            const claim = claimedTransactions.get(txId);
            const actualRupiah = parseGojekAmount(tx.gross_amount || tx.real_gross_amount || 0);
            return {
                id: txId,
                transaction_id: tx.id || txId,
                order_id: tx.order_id || txId,
                amount: actualRupiah,
                status: (tx.transaction_status || 'SETTLEMENT').toUpperCase(),
                issuer: tx.qris_provider_aspi_issuer || 'GoPay / Bank',
                merchant_name: process.env.GOPAY_MERCHANT_NAME || 'Bion, Digital & Kreatif',
                time: tx.transaction_time || tx.settlement_time,
                timestamp: new Date(tx.transaction_time || tx.settlement_time).getTime(),
                channel: tx.channel_type || tx.service_type || 'QRIS',
                rrn: tx.qris_provider_retrieval_reference_number || tx.merchant_cross_reference_id || '-',
                claimed_by: claim ? (claim.qrisId || 'TERKLAIM') : null,
                provider: 'GOPAY'
            };
        });
        lastMutationsFetch = now;
        return cachedMutations;
    } catch (err) {
        return cachedMutations;
    }
}

// Background Worker: Otomatis sinkronisasi & verifikasi setiap sesi QRIS yang berstatus PENDING
async function autoMatchPendingQris() {
    const pendingList = [];
    const now = Date.now();
    for (const [id, q] of qrisStore.entries()) {
        if (q.status === 'PENDING' && (now - q.createdAt.getTime() < 30 * 60 * 1000)) {
            pendingList.push({ id, q });
        }
    }

    if (pendingList.length === 0) return;

    try {
        for (const item of pendingList) {
            let matched = null;
            const provider = (item.q.provider || 'AUTO').toUpperCase();

            if (provider === 'SHOPEEPAY') {
                matched = await shopeeManager.verifyShopeePayment(item.q.amount, item.q.createdAt, item.q.trxId || item.id);
            } else if (provider === 'GOPAY') {
                matched = await verifyPayment(item.q.amount, item.q.createdAt, null, null, item.q.trxId || item.id);
            } else {
                // AUTO: Coba GoPay dulu, jika belum ada cek ShopeePay
                try {
                    matched = await verifyPayment(item.q.amount, item.q.createdAt, null, null, item.q.trxId || item.id);
                } catch (e) {}
                if (!matched) {
                    try {
                        matched = await shopeeManager.verifyShopeePayment(item.q.amount, item.q.createdAt, item.q.trxId || item.id);
                    } catch (e) {}
                }
            }

            if (matched) {
                item.q.status = 'PAID';
                item.q.amount = matched.amount || item.q.amount;
                item.q.transaction = matched;
                item.q.provider = matched.provider || item.q.provider || 'GOPAY';
                qrisStore.set(item.id, item.q);
                saveStore();
                logActivity('SUCCESS', `Auto-Match [${item.q.provider}]: Pembayaran QRIS ID ${item.id} (TRX: ${item.q.trxId}) otomatis diverifikasi lunas Rp ${item.q.amount} via ${matched.payer_issuer}!`);
                dispatchWebhook(item.q, matched);
            }
        }
    } catch (e) {
        // Silently continue
    }
}
setInterval(autoMatchPendingQris, 10000); // Otomatis periksa setiap 10 detik

// Hitung Checksum CRC16 EMVCo untuk QRIS
function calculateCRC16(payload) {
    let crc = 0xFFFF;
    for (let i = 0; i < payload.length; i++) {
        crc ^= payload.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x8000) !== 0) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

// Generate QRIS Dinamis Standar EMVCo (Parsing TLV Presisi Tinggi)
function generateDynamicQRIS(staticTemplate, amount) {
    if (!staticTemplate) return null;
    let payload = staticTemplate.trim();

    // Hapus Tag 63 (CRC) lama jika ada di akhir
    const idx63 = payload.indexOf('6304');
    if (idx63 !== -1) {
        payload = payload.substring(0, idx63);
    }

    // Parse EMVCo TLV Tags
    const tags = [];
    let i = 0;
    try {
        while (i < payload.length) {
            const tag = payload.substring(i, i + 2);
            const length = parseInt(payload.substring(i + 2, i + 4), 10);
            if (isNaN(length)) break;
            const val = payload.substring(i + 4, i + 4 + length);
            tags.push({ tag, val });
            i += 4 + length;
        }
    } catch (e) {
        return null;
    }

    const amountStr = parseInt(amount, 10).toString();
    const newTags = [];
    let hasTag54 = false;

    for (const item of tags) {
        if (item.tag === '01') {
            // Ubah Static (11) ke Dynamic (12)
            newTags.push({ tag: '01', val: '12' });
        } else if (item.tag === '54') {
            newTags.push({ tag: '54', val: amountStr });
            hasTag54 = true;
        } else if (item.tag === '58' && !hasTag54) {
            newTags.push({ tag: '54', val: amountStr });
            hasTag54 = true;
            newTags.push(item);
        } else {
            newTags.push(item);
        }
    }

    if (!hasTag54) {
        newTags.push({ tag: '54', val: amountStr });
    }

    let result = '';
    for (const item of newTags) {
        const lenStr = item.val.length.toString().padStart(2, '0');
        result += `${item.tag}${lenStr}${item.val}`;
    }

    result += '6304';
    const checksum = calculateCRC16(result);
    return result + checksum;
}

// Dispatch Webhook Callback ke Server Merchant
async function dispatchWebhook(qris, transaction) {
    if (!qris || !qris.callbackUrl) return;
    try {
        const payload = {
            event: 'payment.success',
            qris_id: qris.qrisId,
            trx_id: qris.trxId,
            order_id: qris.orderId || null,
            amount: qris.amount,
            payer_issuer: transaction?.payer_issuer || 'GoPay / Bank',
            payment_type: transaction?.payment_type || 'QRIS',
            transaction_time: transaction?.transaction_time || new Date().toISOString(),
            timestamp: Date.now()
        };

        const secret = process.env.API_KEY || 'gopay';
        const signature = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

        logActivity('INFO', `Mengirim Webhook ke ${qris.callbackUrl} untuk TRX ${qris.trxId}...`);
        const res = await axios.post(qris.callbackUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-Gateway-Signature': signature,
                'X-Gateway-Event': 'payment.success'
            },
            timeout: 6000
        });
        logActivity('SUCCESS', `Webhook sukses dikirim ke ${qris.callbackUrl} (HTTP ${res.status})`);
    } catch (err) {
        logActivity('WARNING', `Gagal mengirim webhook ke ${qris.callbackUrl}: ${err.message}`);
    }
}

// Middleware Proteksi API Key
const apiKeyAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key || req.query.apikey || req.body?.api_key;
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ success: false, message: 'Autentikasi Gagal: API Key tidak valid' });
    }
    next();
};

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Inisialisasi data persistensi
loadStore();

// Helper: Ambil Merchant ID dari Header, ENV, atau Sesi GoBiz
function getMerchantId(override = null) {
    if (override) return override;
    if (process.env.GOPAY_MERCHANT_ID) return process.env.GOPAY_MERCHANT_ID;
    try {
        const session = sessionManager.loadSession();
        if (session && session.merchant_id) return session.merchant_id;
    } catch (e) {}
    return '';
}

// Ekstrak Informasi Merchant Lengkap dari Sesi GoBiz/Shopee, ENV, atau QRIS EMVCo
function extractMerchantInfo(qrisPayload = null, preferredProvider = null) {
    let session = null;
    try {
        session = sessionManager.loadSession();
    } catch (e) {}

    const cfg = getEnvConfig();
    let name = '';
    let city = '';
    let merchantId = '';
    let nmid = '';
    let acquirer = '';
    let detectedProvider = preferredProvider ? preferredProvider.toUpperCase() : '';

    const payload = qrisPayload || cfg.qrisStatic;
    if (payload) {
        try {
            let i = 0;
            while (i < payload.length) {
                const tag = payload.substring(i, i + 2);
                const len = parseInt(payload.substring(i + 2, i + 4), 10);
                if (isNaN(len)) break;
                const val = payload.substring(i + 4, i + 4 + len);
                
                if (tag === '59' && val) {
                    name = val;
                } else if (tag === '60' && val) {
                    city = val;
                } else if (tag === '26' && val) {
                    if (val.toUpperCase().includes('SHOPEE')) {
                        detectedProvider = 'SHOPEEPAY';
                        acquirer = 'ShopeePay (AirPay Indonesia)';
                    } else if (val.toUpperCase().includes('GO-JEK') || val.toUpperCase().includes('GOPAY')) {
                        detectedProvider = 'GOPAY';
                        acquirer = 'GoPay (PT Dompet Anak Bangsa)';
                    }
                    let j = 0;
                    while (j < val.length) {
                        const subTag = val.substring(j, j + 2);
                        const subLen = parseInt(val.substring(j + 2, j + 4), 10);
                        if (isNaN(subLen)) break;
                        const subVal = val.substring(j + 4, j + 4 + subLen);
                        if (subTag === '02') {
                            merchantId = subVal;
                        }
                        j += 4 + subLen;
                    }
                } else if (tag === '51' && val) {
                    let j = 0;
                    while (j < val.length) {
                        const subTag = val.substring(j, j + 2);
                        const subLen = parseInt(val.substring(j + 2, j + 4), 10);
                        if (isNaN(subLen)) break;
                        const subVal = val.substring(j + 4, j + 4 + subLen);
                        if (subTag === '02') {
                            nmid = subVal;
                        }
                        j += 4 + subLen;
                    }
                }
                i += 4 + len;
            }
        } catch (e) {}
    }

    if (!detectedProvider) {
        detectedProvider = preferredProvider ? preferredProvider.toUpperCase() : 'GOPAY';
    }

    const isShopee = detectedProvider === 'SHOPEEPAY';
    if (isShopee) {
        name = name || 'Bion Digital';
        city = city || 'SUKOHARJO';
        merchantId = merchantId || '23937362';
        nmid = nmid || 'ID1026617878529';
        acquirer = acquirer || 'ShopeePay (AirPay Indonesia)';
    } else {
        name = name || cfg.merchantName || session?.outlet_name || 'Bion, Digital & Kreatif';
        city = city || cfg.merchantCity || 'SUKOHARJO';
        merchantId = merchantId || cfg.merchantId || session?.merchant_id || 'G676629960';
        nmid = nmid || 'ID1026550651487';
        acquirer = acquirer || 'GoPay (PT Dompet Anak Bangsa)';
    }

    return {
        name,
        city,
        merchant_id: merchantId,
        nmid,
        acquirer,
        provider: detectedProvider,
        phone: session?.phone_number || '',
        brand_title: isShopee ? 'ShopeePay Partner' : 'GoPay Merchant',
        brand_badge: isShopee ? 'ShopeePay Partner • QRIS Standar' : 'GoPay Merchant • QRIS Standar',
        brand_color: isShopee ? '#ee4d2d' : '#00aed9',
        brand_color_end: isShopee ? '#ff7337' : '#00b14f',
        footer_note: isShopee 
            ? 'Didukung oleh ShopeePay Partner Unified Gateway Engine' 
            : 'Didukung oleh GoPay Merchant Partner Gateway Engine'
    };
}

// Render Developer & Merchant Dashboard
function renderDashboard(req, res) {
    const dashboardPath = path.join(__dirname, 'views', 'dashboard.html');
    if (!fs.existsSync(dashboardPath)) {
        return res.send('GoPay Partner API Gateway Berjalan');
    }

    const cfg = getEnvConfig();
    const isSandbox = cfg.sandbox;
    const origin = `${req.protocol}://${req.get('host')}`;
    const merchantInfo = extractMerchantInfo(cfg.qrisStatic);

    let html = fs.readFileSync(dashboardPath, 'utf-8');
    html = html
        .replace(/{{ENV_TEXT}}/g, isSandbox ? 'SANDBOX' : 'PRODUCTION')
        .replace(/{{ENV_BADGE_CLASS}}/g, isSandbox ? 'badge-sandbox' : 'badge-live')
        .replace(/{{API_KEY}}/g, process.env.API_KEY || '')
        .replace(/{{ORIGIN}}/g, origin)
        .replace(/{{MERCHANT_NAME}}/g, merchantInfo.name)
        .replace(/{{MERCHANT_CITY}}/g, merchantInfo.city)
        .replace(/{{MERCHANT_ID}}/g, merchantInfo.merchant_id || '-');

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
}

// Route Root & Dashboard
app.get('/', (req, res) => {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json({
            status: 'OK',
            service: 'GoPay Partner API Gateway',
            version: '1.0.0',
            sandbox_mode: process.env.SANDBOX_MODE === 'true',
            timestamp: new Date()
        });
    }
    renderDashboard(req, res);
});

app.get('/dashboard', (req, res) => {
    renderDashboard(req, res);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        service: 'GoPay Partner API Gateway',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date()
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Layanan API GoPay Berfungsi Normal',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date()
    });
});

// Cek Status Sesi & Token (GoPay, ShopeePay, atau Keduanya)
app.get(['/token-status', '/api/token-status'], apiKeyAuth, async (req, res) => {
    const provider = (req.query.provider || '').toUpperCase();

    // Jika ShopeePay diminta secara spesifik
    if (provider === 'SHOPEEPAY') {
        const isValid = await shopeeManager.checkShopeeToken();
        const shopeeInfo = shopeeManager.getShopeeStatus();
        return res.json({
            status: isValid,
            success: isValid,
            data: {
                provider: 'SHOPEEPAY',
                token_status: isValid ? 'valid' : (shopeeInfo.configured ? 'expired' : 'not_configured'),
                valid: isValid,
                merchant_name: shopeeInfo.merchant_name,
                expiry: shopeeInfo.expiry,
                message: isValid ? 'ShopeePay Token aktif dan berfungsi' : (shopeeInfo.configured ? 'ShopeePay Token kadaluarsa / tidak valid' : 'ShopeePay Token belum dikonfigurasi')
            }
        });
    }

    // Jika GoPay diminta secara spesifik
    if (provider === 'GOPAY') {
        const activeHeaders = await sessionManager.getValidHeaders(req.headers['user-agent']);
        const isSandbox = process.env.SANDBOX_MODE === 'true';
        if (!activeHeaders) {
            return res.json({
                status: isSandbox,
                success: isSandbox,
                data: {
                    provider: 'GOPAY',
                    token_status: isSandbox ? 'sandbox_active' : 'invalid',
                    message: isSandbox ? 'Mode Sandbox Aktif' : 'Sesi GoPay belum dikonfigurasi. Jalankan `node login.js`'
                }
            });
        }
        return res.json({
            status: true,
            success: true,
            data: {
                provider: 'GOPAY',
                token_status: 'valid',
                message: 'Token dan Sesi GoPay Merchant Aktif'
            }
        });
    }

    // Default: Kembalikan status kedua provider
    const activeHeaders = await sessionManager.getValidHeaders(req.headers['user-agent']);
    const isSandbox = process.env.SANDBOX_MODE === 'true';
    const isGopayValid = Boolean(activeHeaders) || isSandbox;
    const isShopeeValid = await shopeeManager.checkShopeeToken();
    const shopeeInfo = shopeeManager.getShopeeStatus();

    res.json({
        status: isGopayValid || isShopeeValid,
        success: true,
        data: {
            gopay: {
                configured: Boolean(activeHeaders) || isSandbox,
                status: isGopayValid ? 'valid' : 'invalid',
                message: isGopayValid ? (isSandbox ? 'Sandbox Aktif' : 'Sesi GoPay Aktif') : 'Perlu node login.js'
            },
            shopee: {
                configured: Boolean(shopeeInfo.configured),
                valid: isShopeeValid,
                status: isShopeeValid ? 'valid' : (shopeeInfo.configured ? 'expired' : 'not_configured'),
                merchant_name: shopeeInfo.merchant_name,
                expiry: shopeeInfo.expiry,
                message: isShopeeValid ? 'ShopeePay Token Aktif' : (shopeeInfo.configured ? 'Token Expired / Error' : 'Token Belum Diisi')
            }
        }
    });
});

app.get('/api/gopay/token-status', apiKeyAuth, async (req, res) => {
    req.query.provider = 'GOPAY';
    return app._router.handle(req, res);
});

// Dashboard Telemetry & Stats API
app.get('/api/dashboard/stats', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key || req.query.apikey;
    const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip?.includes('127.0.0.1');
    if (!isLocal && (!apiKey || apiKey !== process.env.API_KEY)) {
        return res.status(401).json({ success: false, message: 'Autentikasi Gagal' });
    }

    const allQris = [];
    let totalPaid = 0;
    let totalVolume = 0;

    for (const [id, q] of qrisStore.entries()) {
        allQris.unshift({
            qrisId: id,
            trxId: q.trxId,
            orderId: q.orderId || null,
            amount: q.amount,
            status: q.status,
            createdAt: q.createdAt,
            expiresAt: q.expiresAt,
            transaction: q.transaction || null
        });
        if (q.status === 'PAID') {
            totalPaid++;
            totalVolume += q.amount;
        }
    }

    const session = sessionManager.loadSession();
    const hasSession = !!(session && session.refresh_token);
    const cfg = getEnvConfig();
    const merchantInfo = extractMerchantInfo(cfg.qrisStatic);

    // Ambil mutasi real-time settlement dari GoBiz & ShopeePay (default 7 hari)
    const daysQuery = parseInt(req.query.days || req.query.range || '7', 10);
    let mutations = await getLiveGoBizMutations(req.query.force === '1', daysQuery);
    
    // Tag provider GOPAY pada mutasi GoBiz
    mutations = mutations.map(m => ({ 
        ...m, 
        provider: 'GOPAY',
        merchant_name: m.merchant_name || process.env.GOPAY_MERCHANT_NAME || 'Bion, Digital & Kreatif'
    }));

    // Jika ShopeePay dikonfigurasi, ambil juga mutasi ShopeePay
    const hasShopee = !!shopeeManager.getShopeeToken();
    if (hasShopee) {
        try {
            const shopeeMuts = await shopeeManager.getShopeeMutations(daysQuery, 50);
            mutations = mutations.concat(shopeeMuts);
            // Sort by time descending
            mutations.sort((a, b) => new Date(b.time || b.timestamp || 0) - new Date(a.time || a.timestamp || 0));
        } catch (e) {}
    }

    const settledMutations = mutations.filter(m => (m.status || 'SETTLEMENT').toUpperCase() === 'SETTLEMENT');
    const mutationSettledVolume = settledMutations.reduce((sum, m) => sum + (Number(m.amount) || 0), 0);
    const mutationSettledCount = settledMutations.length;

    res.json({
        success: true,
        stats: {
            total_created: qrisStore.size,
            total_paid: totalPaid > 0 ? totalPaid : mutationSettledCount,
            total_volume: totalVolume > 0 ? totalVolume : mutationSettledVolume,
            settlement_volume: mutationSettledVolume,
            settlement_count: mutationSettledCount,
            active_sessions: qrisStore.size,
            session_status: hasSession ? 'AUTHENTICATED' : 'NOT_CONFIGURED',
            gopay_session_status: hasSession ? 'AUTHENTICATED' : 'NOT_CONFIGURED',
            shopee_session_status: hasShopee ? (shopeeManager.isTokenValid() ? 'AUTHENTICATED' : 'INVALID') : 'NOT_CONFIGURED',
            shopee_configured: hasShopee,
            shopee_merchant_name: shopeeManager.getShopeeStatus().merchant_name || 'Bion Digital',
            uptime: Math.floor(process.uptime()),
            sandbox_mode: cfg.sandbox,
            port: PORT,
            merchant_name: merchantInfo.name,
            merchant_city: merchantInfo.city,
            merchant_id: cfg.merchantId || merchantInfo.merchant_id || null
        },
        recent_qris: allQris.slice(0, 50),
        recent_mutations: mutations.slice(0, 50),
        recent_logs: activityLogs.slice(0, 50)
    });
});

// Endpoint Manual Trigger Sinkronisasi Mutasi (GoBiz + ShopeePay)
app.post('/api/sync-mutations', async (req, res) => {
    try {
        await autoMatchPendingQris();
        let mutations = await getLiveGoBizMutations(true, req.query.days || req.body?.days || 1);
        mutations = mutations.map(m => ({ ...m, provider: 'GOPAY' }));

        if (shopeeManager.getShopeeToken()) {
            try {
                const shopeeMuts = await shopeeManager.getShopeeMutations(req.query.days || req.body?.days || 1, 30);
                mutations = mutations.concat(shopeeMuts);
                mutations.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
            } catch (e) {}
        }

        res.json({
            success: true,
            message: 'Mutasi berhasil disinkronkan langsung dari GoBiz & ShopeePay',
            mutations_count: mutations.length,
            mutations: mutations.slice(0, 50)
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint untuk mengosongkan seluruh riwayat sesi gateway
app.post('/api/clear-history', (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key || req.query.apikey || req.body?.api_key;
    const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip?.includes('127.0.0.1');
    if (!isLocal && (!apiKey || apiKey !== process.env.API_KEY)) {
        return res.status(401).json({ success: false, message: 'Autentikasi Gagal' });
    }

    qrisStore.clear();
    claimedTransactions.clear();
    saveStore();
    logActivity('INFO', 'Seluruh riwayat sesi QRIS dan mutasi gateway telah dikosongkan.');
    res.json({ success: true, message: 'Seluruh riwayat sesi gateway berhasil dikosongkan (0 transaksi)' });
});

// Endpoint Manual Match: Pasangkan Mutasi GoBiz ke Sesi QRIS
app.post('/api/claim-mutation', async (req, res) => {
    const qrisId = req.body?.qris_id;
    const txId = req.body?.transaction_id;

    if (!qrisId || !txId) {
        return res.status(400).json({ success: false, message: 'qris_id dan transaction_id diperlukan' });
    }

    const qris = qrisStore.get(qrisId);
    if (!qris) {
        return res.status(404).json({ success: false, message: 'Sesi QRIS tidak ditemukan' });
    }

    try {
        const mutations = await getLiveGoBizMutations(true);
        const targetTx = mutations.find(m => m.id === txId || m.order_id === txId);

        if (!targetTx) {
            return res.status(404).json({ success: false, message: 'Transaksi GoBiz tidak ditemukan' });
        }

        const txObj = {
            transaction_id: targetTx.id,
            order_id: targetTx.order_id,
            amount: targetTx.amount,
            payer_issuer: targetTx.issuer || 'BCA / GoPay',
            payment_type: targetTx.channel || 'QRIS',
            transaction_time: targetTx.time || new Date().toISOString()
        };

        qris.status = 'PAID';
        qris.amount = targetTx.amount;
        qris.transaction = txObj;
        qrisStore.set(qrisId, qris);
        claimedTransactions.set(targetTx.id, { qrisId: qris.trxId || qrisId, claimedAt: Date.now() });
        saveStore();

        logActivity('SUCCESS', `Manual Klaim: Mutasi GoBiz ${targetTx.id} (Rp ${targetTx.amount} via ${targetTx.issuer}) berhasil dipasangkan ke QRIS ${qrisId}`);
        dispatchWebhook(qris, txObj);

        res.json({
            success: true,
            message: 'Status QRIS berhasil diubah menjadi PAID',
            qris,
            transaction: txObj
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Buat QRIS Dinamis (Support GET query & POST body - Provider: GOPAY, SHOPEEPAY, atau AUTO)
function handleCreateDynamicQRIS(req, res) {
    let rawAmount = req.body?.amount || req.query?.amount;
    if (typeof rawAmount === 'string') {
        rawAmount = rawAmount.replace(/[^0-9]/g, '');
    }
    const amount = parseInt(rawAmount, 10);
    if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Nominal pembayaran tidak valid (gunakan ?amount=...)' });
    }

    const reqProvider = (req.body?.provider || req.query?.provider || 'AUTO').toUpperCase();
    let chosenProvider = 'GOPAY';
    let staticTemplate = '';

    if (reqProvider === 'SHOPEEPAY') {
        chosenProvider = 'SHOPEEPAY';
        staticTemplate = getStaticQRIS('SHOPEEPAY');
        if (!staticTemplate) {
            return res.status(400).json({
                success: false,
                message: 'Template QRIS Statis ShopeePay (SHOPEE_QRIS_STATIC) belum diisi di konfigurasi (.env). Silakan masukkan string QRIS toko ShopeePay Anda terlebih dahulu.'
            });
        }
    } else if (reqProvider === 'GOPAY') {
        chosenProvider = 'GOPAY';
        staticTemplate = getStaticQRIS('GOPAY');
        if (!staticTemplate) {
            return res.status(400).json({
                success: false,
                message: 'Template QRIS Statis GoPay (QRIS_STATIC) belum diisi di konfigurasi (.env).'
            });
        }
    } else {
        // AUTO selection: prefer GOPAY if configured, otherwise SHOPEEPAY
        staticTemplate = getStaticQRIS('GOPAY');
        if (!staticTemplate) {
            staticTemplate = getStaticQRIS('SHOPEEPAY');
            if (staticTemplate) chosenProvider = 'SHOPEEPAY';
        }
    }

    if (!staticTemplate) {
        return res.status(500).json({ success: false, message: 'QRIS_STATIC atau SHOPEE_QRIS_STATIC belum dikonfigurasi di .env' });
    }

    const dynamicCode = generateDynamicQRIS(staticTemplate, amount);
    if (!dynamicCode) {
        return res.status(500).json({ success: false, message: 'Gagal memproses QRIS statis template' });
    }

    const qrisId = Math.random().toString(36).substring(2, 10);
    const trxId = 'TRX-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    const expiresAt = new Date(Date.now() + QRIS_EXPIRY_MS);
    const createdAt = new Date();

    const orderId = req.body?.order_id || req.query?.order_id || req.body?.orderId || null;
    const callbackUrl = req.body?.callback_url || req.query?.callback_url || req.body?.callbackUrl || null;
    const returnUrl = req.body?.return_url || req.query?.return_url || req.body?.returnUrl || null;

    const qrisData = {
        qrisId,
        data: dynamicCode,
        amount: parseInt(amount, 10),
        orderId,
        callbackUrl,
        returnUrl,
        trxId,
        provider: chosenProvider,
        expiresAt,
        createdAt,
        status: 'PENDING'
    };

    qrisStore.set(qrisId, qrisData);
    saveStore();

    const host = req.get('host');
    const protocol = req.protocol;
    const publicUrl = `${protocol}://${host}/qr/${qrisId}`;
    const qrImageUrl = `${protocol}://${host}/qr/${qrisId}/image.png`;

    logActivity('INFO', `QRIS Dinamis dibuat [${chosenProvider}] | TRX-ID: ${trxId} | Nominal: Rp ${parseInt(amount, 10)} | Order ID: ${orderId || '-'}`);

    res.json({
        success: true,
        data: {
            qris_id: qrisId,
            trx_id: trxId,
            provider: chosenProvider,
            order_id: orderId,
            qris_url: publicUrl,
            qr_image_url: qrImageUrl,
            qris_code: dynamicCode,
            amount: parseInt(amount, 10),
            callback_url: callbackUrl,
            return_url: returnUrl,
            expires_at: expiresAt.toISOString(),
            expires_in: '5 menit'
        }
    });
}

app.all('/create-qris', apiKeyAuth, handleCreateDynamicQRIS);
app.post('/api/qris/create', apiKeyAuth, handleCreateDynamicQRIS);

// Endpoint Gambar QRIS (Lokal, HD, Support Scanner Mobile Semua Bank & E-Wallet)
app.get('/qr/:id/image.png', async (req, res) => {
    const qris = qrisStore.get(req.params.id);
    if (!qris) {
        return res.status(404).send('QRIS tidak ditemukan atau telah kedaluwarsa');
    }

    try {
        const buffer = await QRCode.toBuffer(qris.data, {
            type: 'png',
            width: 450,
            margin: 2,
            errorCorrectionLevel: 'M',
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.send(buffer);
    } catch (err) {
        return res.status(500).send('Gagal membuat gambar QR: ' + err.message);
    }
});

// Render Halaman HTML QRIS Interaktif (Modernized & Anti-Slop Compliant)
app.get('/qr/:id', (req, res) => {
    const qris = qrisStore.get(req.params.id);
    if (!qris) {
        return res.status(404).send('<h3>Gambar QRIS tidak ditemukan atau telah kedaluwarsa</h3>');
    }

    // Redirect ke gambar mentah jika diminta format=raw
    if (req.query.format === 'raw' || req.query.raw === '1') {
        if (Date.now() > qris.expiresAt.getTime()) {
            qrisStore.delete(req.params.id);
            saveStore();
            return res.status(410).send('QRIS Kedaluwarsa');
        }
        return res.redirect(302, `/qr/${req.params.id}/image.png`);
    }

    const formattedAmount = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(qris.amount);
    const qrImageUrl = `/qr/${req.params.id}/image.png`;
    const cfg = getEnvConfig();
    const isSandbox = cfg.sandbox;
    const isPaid = qris.status === 'PAID';

    const checkoutViewPath = path.join(__dirname, 'views', 'checkout.html');
    if (fs.existsSync(checkoutViewPath)) {
        const merchantInfo = extractMerchantInfo(qris.data, qris.provider);
        let html = fs.readFileSync(checkoutViewPath, 'utf-8');
        html = html
            .replace(/{{FORMATTED_AMOUNT}}/g, formattedAmount)
            .replace(/{{AMOUNT_RAW}}/g, String(qris.amount))
            .replace(/{{QR_IMAGE_URL}}/g, qrImageUrl)
            .replace(/{{TRX_ID}}/g, qris.trxId)
            .replace(/{{ORDER_ID}}/g, qris.orderId || qris.trxId)
            .replace(/{{QRIS_ID}}/g, req.params.id)
            .replace(/{{QRIS_CODE}}/g, qris.data)
            .replace(/{{MERCHANT_NAME}}/g, merchantInfo.name)
            .replace(/{{MERCHANT_CITY}}/g, merchantInfo.city)
            .replace(/{{MERCHANT_NMID}}/g, merchantInfo.nmid)
            .replace(/{{MERCHANT_ID}}/g, merchantInfo.merchant_id)
            .replace(/{{ACQUIRER}}/g, merchantInfo.acquirer)
            .replace(/{{PROVIDER}}/g, merchantInfo.provider)
            .replace(/{{BRAND_TITLE}}/g, merchantInfo.brand_title)
            .replace(/{{BRAND_BADGE}}/g, merchantInfo.brand_badge)
            .replace(/{{BRAND_COLOR}}/g, merchantInfo.brand_color)
            .replace(/{{BRAND_COLOR_END}}/g, merchantInfo.brand_color_end)
            .replace(/{{FOOTER_NOTE}}/g, merchantInfo.footer_note)
            .replace(/{{EXPIRES_TIMESTAMP}}/g, qris.expiresAt.getTime().toString())
            .replace(/{{RETURN_URL}}/g, qris.returnUrl || '')
            .replace(/{{SERVER_IS_PAID}}/g, isPaid ? 'true' : 'false')
            .replace(/{{SERVER_TX}}/g, isPaid ? JSON.stringify(qris.transaction) : 'null')
            .replace(/{{SIMULATE_BUTTON}}/g, isSandbox ? `
                <button type="button" class="btn-action btn-simulate" id="btn-simulate" onclick="simulateCustomerPayment()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                    <span>Simulasikan Bayar (Sandbox Mode)</span>
                </button>
            ` : '');

        res.setHeader('Content-Type', 'text/html');
        return res.send(html);
    }

    // Fallback minimal jika view tidak ditemukan
    res.send(`<h2>QRIS Payment: ${formattedAmount}</h2><img src="${qrImageUrl}"/>`);
});

// Endpoint Public Check Status QRIS
app.get('/api/qr-status/:id', async (req, res) => {
    const qrisId = req.params.id;
    const qris = qrisStore.get(qrisId);
    if (!qris) {
        return res.json({ success: false, status: 'NOT_FOUND', message: 'QRIS tidak ditemukan' });
    }

    if (qris.status === 'PAID') {
        return res.json({ success: true, paid: true, status: 'PAID', transaction: qris.transaction });
    }

    try {
        const matched = await verifyPayment(qris.amount, qris.createdAt, null, req.headers['user-agent'], qris.trxId || qrisId);
        if (matched) {
            qris.status = 'PAID';
            qris.amount = matched.amount || qris.amount;
            qris.transaction = matched;
            qrisStore.set(qrisId, qris);
            saveStore();
            logActivity('SUCCESS', `Pembayaran QRIS ID ${qrisId} terverifikasi lunas untuk nominal Rp ${qris.amount} via ${matched.payer_issuer}`);

            // Kirim webhook ke callback merchant
            dispatchWebhook(qris, matched);

            return res.json({ success: true, paid: true, status: 'PAID', transaction: matched });
        }
    } catch (err) {
        logActivity('WARNING', `Periksa status /api/qr-status/${qrisId}: ${err.message}`);
    }

    if (Date.now() > qris.expiresAt.getTime() + 60000) {
        qris.status = 'EXPIRED';
        qrisStore.set(qrisId, qris);
        saveStore();
        return res.json({ success: false, paid: false, status: 'EXPIRED', message: 'QRIS sudah kedaluwarsa' });
    }

    return res.json({ success: true, paid: false, status: 'PENDING', message: 'Belum ada pembayaran masuk' });
});

// Endpoint Simulasi Pembayaran (Sandbox Mode)
app.post('/api/simulate-payment', (req, res) => {
    const qrisId = req.body?.qris_id || req.query?.qris_id;
    const trxId = req.body?.trx_id || req.query?.trx_id;

    let targetQris = null;
    let targetQrisId = null;

    if (qrisId && qrisStore.has(qrisId)) {
        targetQris = qrisStore.get(qrisId);
        targetQrisId = qrisId;
    } else if (trxId) {
        for (const [id, q] of qrisStore.entries()) {
            if (q.trxId === trxId) {
                targetQris = q;
                targetQrisId = id;
                break;
            }
        }
    }

    if (!targetQris) {
        return res.status(404).json({ success: false, message: 'QRIS tidak ditemukan untuk simulasi' });
    }

    const txId = 'SIM-TX-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    const mockTx = {
        transaction_id: txId,
        order_id: targetQris.orderId || 'ORDER-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        amount: targetQris.amount,
        payer_issuer: 'GoPay / Bank Transfer (Sandbox)',
        payment_type: 'QRIS_SANDBOX',
        transaction_time: new Date().toISOString()
    };

    targetQris.status = 'PAID';
    targetQris.transaction = mockTx;
    qrisStore.set(targetQrisId, targetQris);
    claimedTransactions.set(txId, { qrisId: targetQrisId, claimedAt: Date.now() });
    saveStore();

    logActivity('SUCCESS', `[SANDBOX] Simulasi pembayaran lunas untuk QRIS ID ${targetQrisId} | TRX: ${targetQris.trxId}`);

    // Dispatch webhook
    dispatchWebhook(targetQris, mockTx);

    res.json({
        success: true,
        message: 'Simulasi pembayaran berhasil diverifikasi lunas',
        transaction: mockTx
    });
});

// Ambil Riwayat Transaksi (UNIFIED MUTASI: GOPAY + SHOPEEPAY + GENERATED PENDING QRIS)
app.get('/transactions', apiKeyAuth, async (req, res) => {
    try {
        const days = parseInt(req.query.days || req.query.range || '7', 10);
        const providerFilter = (req.query.provider || 'ALL').toUpperCase();
        const statusFilter = (req.query.status || 'ALL').toUpperCase(); // ALL, SETTLEMENT, PENDING, EXPIRED
        const force = req.query.force === '1' || req.query.force === 'true';

        let unifiedMutations = [];

        // 1. Fetch GoPay Mutations (Settlement)
        if ((providerFilter === 'ALL' || providerFilter === 'GOPAY') && statusFilter !== 'PENDING' && statusFilter !== 'EXPIRED') {
            try {
                let gopayMuts = await getLiveGoBizMutations(force, days);
                gopayMuts = gopayMuts.map(m => ({
                    ...m,
                    provider: 'GOPAY',
                    merchant_name: m.merchant_name || process.env.GOPAY_MERCHANT_NAME || 'Bion, Digital & Kreatif'
                }));
                unifiedMutations = unifiedMutations.concat(gopayMuts);
            } catch (gpErr) {
                console.error('[Transactions] Gagal fetch GoPay:', gpErr.message);
            }
        }

        // 2. Fetch ShopeePay Mutations
        if (providerFilter === 'ALL' || providerFilter === 'SHOPEEPAY') {
            if (shopeeManager.getShopeeToken()) {
                try {
                    const shopeeMuts = await shopeeManager.getShopeeMutations(days, 50);
                    // Filter based on statusFilter if not ALL
                    const filteredShopee = shopeeMuts.filter(t => {
                        if (statusFilter === 'ALL') return true;
                        if (statusFilter === 'SETTLEMENT') return (t.status || '').toUpperCase() === 'SETTLEMENT';
                        if (statusFilter === 'PENDING') return (t.status || '').toUpperCase() === 'PENDING';
                        return true;
                    });
                    unifiedMutations = unifiedMutations.concat(filteredShopee);
                } catch (spErr) {
                    console.error('[Transactions] Gagal fetch ShopeePay:', spErr.message);
                }
            }
        }

        // 3. Masukkan Sesi QRIS Dinamis yang Di-generate dari qrisStore (PENDING / EXPIRED)
        const now = Date.now();
        for (const [id, q] of qrisStore.entries()) {
            if (q.status === 'PAID') {
                continue;
            }

            const qCreated = new Date(q.createdAt || now);
            const createdMs = qCreated.getTime();
            if (now - createdMs > days * 24 * 3600 * 1000) continue;

            const qProvider = (q.provider || 'GOPAY').toUpperCase();
            if (providerFilter !== 'ALL' && providerFilter !== qProvider) continue;

            const isStillActive = q.expiresAt ? (new Date(q.expiresAt).getTime() > now) : false;
            let currentStatus = q.status || 'PENDING';
            if (currentStatus === 'PENDING' && !isStillActive && (now - new Date(q.expiresAt).getTime() > 0)) {
                currentStatus = 'EXPIRED';
            }

            // Apply status filter
            if (statusFilter === 'SETTLEMENT') continue;
            if (statusFilter === 'PENDING' && currentStatus !== 'PENDING') continue;
            if (statusFilter === 'EXPIRED' && currentStatus !== 'EXPIRED') continue;

            // Hindari duplikasi jika ID atau Order ID sudah ada
            const isDup = unifiedMutations.some(m => m.id === id || (m.order_id && m.order_id === q.orderId));
            if (!isDup) {
                const isShopee = qProvider === 'SHOPEEPAY';
                const merchantName = isShopee 
                    ? (shopeeManager.getShopeeStatus().merchant_name || 'Bion Digital')
                    : (process.env.GOPAY_MERCHANT_NAME || 'Bion, Digital & Kreatif');

                unifiedMutations.push({
                    id: q.qrisId,
                    transaction_id: q.trxId,
                    order_id: q.orderId || q.trxId,
                    amount: q.amount,
                    status: currentStatus,
                    issuer: currentStatus === 'PENDING' ? 'Menunggu Pembayaran (Semua E-Wallet/Bank)' : 'Kedaluwarsa (Belum Dibayar)',
                    merchant_name: merchantName,
                    time: typeof q.createdAt === 'string' ? q.createdAt : q.createdAt.toISOString(),
                    timestamp: createdMs,
                    channel: 'QRIS_DINAMIS',
                    rrn: q.trxId,
                    qris_id: q.qrisId,
                    qris_url: `/qr/${q.qrisId}`,
                    expires_at: typeof q.expiresAt === 'string' ? q.expiresAt : q.expiresAt?.toISOString(),
                    provider: qProvider,
                    is_generated_qris: true
                });
            }
        }

        // Sort descending by time
        unifiedMutations.sort((a, b) => {
            const timeA = new Date(a.time || a.timestamp || 0).getTime();
            const timeB = new Date(b.time || b.timestamp || 0).getTime();
            return timeB - timeA;
        });

        // Filter settlement / pending list for accurate metrics
        const settledList = unifiedMutations.filter(t => (t.status || '').toUpperCase() === 'SETTLEMENT' || (t.status || '').toUpperCase() === 'PAID');
        const pendingList = unifiedMutations.filter(t => (t.status || '').toUpperCase() === 'PENDING');
        const expiredList = unifiedMutations.filter(t => (t.status || '').toUpperCase() === 'EXPIRED');

        const totalSettlementAmount = settledList.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
        const totalPendingAmount = pendingList.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);

        const gopaySettled = settledList.filter(t => t.provider === 'GOPAY').reduce((s, t) => s + (Number(t.amount) || 0), 0);
        const shopeeSettled = settledList.filter(t => t.provider === 'SHOPEEPAY').reduce((s, t) => s + (Number(t.amount) || 0), 0);

        const gopayPending = pendingList.filter(t => t.provider === 'GOPAY').reduce((s, t) => s + (Number(t.amount) || 0), 0);
        const shopeePending = pendingList.filter(t => t.provider === 'SHOPEEPAY').reduce((s, t) => s + (Number(t.amount) || 0), 0);

        res.json({
            success: true,
            status: true,
            provider: providerFilter,
            status_filter: statusFilter,
            range_days: days,
            total_count: unifiedMutations.length,
            total_amount: String(totalSettlementAmount),
            pending_amount: String(totalPendingAmount),
            summary: {
                total_amount: totalSettlementAmount,
                total_count: unifiedMutations.length,
                settlement_count: settledList.length,
                settlement_amount: totalSettlementAmount,
                pending_count: pendingList.length,
                pending_amount: totalPendingAmount,
                expired_count: expiredList.length,
                gopay: {
                    count: unifiedMutations.filter(t => t.provider === 'GOPAY').length,
                    settlement_count: settledList.filter(t => t.provider === 'GOPAY').length,
                    amount: gopaySettled,
                    pending_count: pendingList.filter(t => t.provider === 'GOPAY').length,
                    pending_amount: gopayPending
                },
                shopee: {
                    count: unifiedMutations.filter(t => t.provider === 'SHOPEEPAY').length,
                    settlement_count: settledList.filter(t => t.provider === 'SHOPEEPAY').length,
                    amount: shopeeSettled,
                    pending_count: pendingList.filter(t => t.provider === 'SHOPEEPAY').length,
                    pending_amount: shopeePending
                }
            },
            data: {
                total_amount: String(totalSettlementAmount),
                total_count: unifiedMutations.length,
                transactions: unifiedMutations
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Shortcut Semua Transaksi Bulan Ini
app.get('/transactions/all', apiKeyAuth, async (req, res) => {
    const now = new Date();
    const startOfMonthUnix = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
    req.query.startTime = startOfMonthUnix;
    req.query.pageSize = 100;
    return app._router.handle({ ...req, url: '/transactions', method: 'GET' }, res);
});

// Core Helper: Verifikasi Pembayaran dari GoPay API
async function verifyPayment(amount, startTime, merchantIdOverride = null, userAgent = null, qrisId = null) {
    let headers = await sessionManager.getValidHeaders(userAgent);

    if (!headers && process.env.SANDBOX_MODE === 'true') {
        // Cek apakah ada QRIS yang sesuai dalam qrisStore yang telah ditandai PAID
        const targetAmount = parseInt(amount, 10);
        for (const [id, q] of qrisStore.entries()) {
            if (q.amount === targetAmount && q.status === 'PAID' && q.transaction) {
                if (!qrisId || q.trxId === qrisId || id === qrisId) {
                    return q.transaction;
                }
            }
        }
        return null;
    }

    if (!headers) {
        throw new Error('Sesi GoPay belum ada. Jalankan `node login.js` di terminal.');
    }

    const fetchCheckPayment = async (activeHeaders) => {
        const merchantId = merchantIdOverride || getMerchantId();
        const now = new Date();
        const startTimeISO = startTime ? new Date(startTime).toISOString() : new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const endTimeISO = now.toISOString();

        return await axios.get(GOJEK_TRANSACTIONS_URL, {
            headers: activeHeaders,
            params: {
                from: 0,
                size: 20,
                statuses: 'SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND',
                payment_types: 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD',
                start_time: startTimeISO,
                end_time: endTimeISO,
                merchant_ids: merchantId
            },
            timeout: 10000
        });
    };

    let response;
    try {
        response = await fetchCheckPayment(headers);
    } catch (firstErr) {
        if (firstErr.response && firstErr.response.status === 401) {
            logActivity('WARNING', 'Sesi expired (401) di verifyPayment. Memulai auto-refresh...');
            const refreshed = await sessionManager.refreshSession();
            if (refreshed) {
                const newHeaders = await sessionManager.getValidHeaders(userAgent);
                response = await fetchCheckPayment(newHeaders);
            } else {
                throw firstErr;
            }
        } else {
            throw firstErr;
        }
    }

    const rawTransactions = response.data?.transactions || response.data?.data?.transactions || response.data?.data || [];
    const targetAmount = parseInt(amount, 10);
    const filterStartTimeMs = startTime ? (new Date(startTime).getTime() - 120000) : 0; // toleransi 2 menit clock skew

    // Tier 1: Exact match nominal (konversi sen ke Rupiah murni)
    for (const tx of rawTransactions) {
        const txAmount = parseGojekAmount(tx.gross_amount || tx.real_gross_amount || tx.amount?.value || tx.amount || 0);
        const txTimestamp = new Date(tx.transaction_time || tx.created_at || tx.settlement_time || 0).getTime();
        const txId = tx.id || tx.order_id || tx.wallstreet_transaction_id;

        if (txAmount === targetAmount && txTimestamp >= filterStartTimeMs) {
            const existingClaim = claimedTransactions.get(txId);

            if (!existingClaim) {
                claimedTransactions.set(txId, { qrisId, claimedAt: Date.now() });
                saveStore();
                logActivity('INFO', `TRX ${txId} (Rp ${txAmount}) diklaim oleh QRIS ${qrisId || 'manual-check'}`);
                return {
                    transaction_id: txId,
                    order_id: tx.order_id,
                    amount: txAmount,
                    payer_issuer: tx.qris_provider_aspi_issuer || 'GoPay / Bank',
                    payment_type: tx.payment_type || tx.transaction_source || 'GOPAY_INSTORE',
                    transaction_time: tx.transaction_time || tx.settlement_time
                };
            } else if (qrisId && existingClaim.qrisId === qrisId) {
                return {
                    transaction_id: txId,
                    order_id: tx.order_id,
                    amount: txAmount,
                    payer_issuer: tx.qris_provider_aspi_issuer || 'GoPay / Bank',
                    payment_type: tx.payment_type || tx.transaction_source || 'GOPAY_INSTORE',
                    transaction_time: tx.transaction_time || tx.settlement_time
                };
            }
        }
    }

    // Tier 2: Time-correlated match untuk sesi spesifik yang sedang aktif diperiksa
    if (qrisId) {
        for (const tx of rawTransactions) {
            const txAmount = parseGojekAmount(tx.gross_amount || tx.real_gross_amount || tx.amount?.value || tx.amount || 0);
            const txTimestamp = new Date(tx.transaction_time || tx.created_at || tx.settlement_time || 0).getTime();
            const txId = tx.id || tx.order_id || tx.wallstreet_transaction_id;

            const isWithinWindow = (txTimestamp >= filterStartTimeMs) && (txTimestamp <= Date.now() + 60000);
            const existingClaim = claimedTransactions.get(txId);

            if (isWithinWindow && !existingClaim) {
                // Pastikan tidak ada sesi pending lain yang nominalnya cocok persis dengan txAmount
                let isExactForOther = false;
                for (const [otherId, otherQ] of qrisStore.entries()) {
                    if (otherId !== qrisId && otherQ.status === 'PENDING' && otherQ.amount === txAmount) {
                        isExactForOther = true;
                        break;
                    }
                }

                if (!isExactForOther) {
                    claimedTransactions.set(txId, { qrisId, claimedAt: Date.now() });
                    saveStore();
                    logActivity('SUCCESS', `Auto-Korelasi Waktu: Mutasi settlement ${txId} (Rp ${txAmount} via ${tx.qris_provider_aspi_issuer || 'Bank'}) berhasil dikaitkan ke QRIS ${qrisId}!`);
                    return {
                        transaction_id: txId,
                        order_id: tx.order_id,
                        amount: txAmount,
                        payer_issuer: tx.qris_provider_aspi_issuer || 'GoPay / Bank',
                        payment_type: tx.payment_type || tx.transaction_source || 'GOPAY_INSTORE',
                        transaction_time: tx.transaction_time || tx.settlement_time
                    };
                }
            } else if (existingClaim && existingClaim.qrisId === qrisId) {
                return {
                    transaction_id: txId,
                    order_id: tx.order_id,
                    amount: txAmount,
                    payer_issuer: tx.qris_provider_aspi_issuer || 'GoPay / Bank',
                    payment_type: tx.payment_type || tx.transaction_source || 'GOPAY_INSTORE',
                    transaction_time: tx.transaction_time || tx.settlement_time
                };
            }
        }
    }
    return null;
}

// Cek Pembayaran Masuk (Support GET query & POST body - Provider: GOPAY, SHOPEEPAY, atau AUTO)
app.all('/check-payment', apiKeyAuth, async (req, res) => {
    const amount = req.body?.amount || req.query?.amount;
    const startTime = req.body?.startTime || req.query?.startTime || req.query?.start_time;
    const scopeId = req.body?.trx_id || req.query?.trx_id || null;
    const provider = (req.body?.provider || req.query?.provider || 'AUTO').toUpperCase();

    if (!amount || isNaN(amount)) {
        return res.status(400).json({ success: false, message: 'Nominal pembayaran tidak valid' });
    }

    try {
        let matchedTransaction = null;
        let lastError = null;

        if (provider === 'SHOPEEPAY') {
            matchedTransaction = await shopeeManager.verifyShopeePayment(amount, startTime, scopeId);
        } else if (provider === 'GOPAY') {
            const merchantId = req.headers['x-gopay-merchant-id'] || null;
            matchedTransaction = await verifyPayment(amount, startTime, merchantId, req.headers['user-agent'], scopeId);
        } else {
            // AUTO: Cek GoPay terlebih dahulu
            try {
                const merchantId = req.headers['x-gopay-merchant-id'] || null;
                matchedTransaction = await verifyPayment(amount, startTime, merchantId, req.headers['user-agent'], scopeId);
            } catch (err) {
                lastError = err;
            }

            // Jika belum ditemukan di GoPay, cek di ShopeePay (jika token ada)
            if (!matchedTransaction && shopeeManager.getShopeeToken()) {
                try {
                    matchedTransaction = await shopeeManager.verifyShopeePayment(amount, startTime, scopeId);
                } catch (err) {
                    lastError = err;
                }
            }
        }

        if (matchedTransaction) {
            logActivity('SUCCESS', `Pembayaran [${matchedTransaction.provider || provider}] terverifikasi lunas untuk nominal Rp ${parseInt(amount, 10)}`, matchedTransaction);
            return res.json({
                success: true,
                paid: true,
                transaction: matchedTransaction
            });
        } else {
            return res.json({
                success: true,
                paid: false,
                message: 'Pembayaran belum ditemukan atau sudah pernah diklaim'
            });
        }
    } catch (err) {
        const errorDetail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
        logActivity('ERROR', `Gagal periksa pembayaran: ${errorDetail}`);
        return res.status(500).json({
            success: false,
            message: 'Gagal mengambil data transaksi dari API Merchant',
            error: errorDetail
        });
    }
});

// ── ShopeePay Dedicated Compatibility Endpoints ──────────────────────────────
app.post(['/update-token', '/api/shopee/update-token'], apiKeyAuth, async (req, res) => {
    const token = req.body?.token || req.query?.token;
    if (!token) {
        return res.status(400).json({ success: false, status: false, error: 'Provide token in body (token)' });
    }
    const success = shopeeManager.updateShopeeToken(token);
    if (!success) {
        return res.status(500).json({ success: false, status: false, error: 'Gagal menyimpan ShopeePay Token' });
    }

    try {
        const isValid = await shopeeManager.checkShopeeToken();
        const shopeeStatus = shopeeManager.getShopeeStatus();
        if (isValid) {
            logActivity('INFO', `ShopeePay Token berhasil diperbarui & diverifikasi aktif (${shopeeStatus.merchant_name || 'Bion Digital'})`);
            return res.json({
                success: true,
                status: true,
                message: 'ShopeePay Token berhasil diperbarui dan terverifikasi aktif',
                data: {
                    merchant_name: shopeeStatus.merchant_name || 'Bion Digital',
                    valid: true
                }
            });
        } else {
            logActivity('WARN', 'ShopeePay Token disimpan tetapi ditolak oleh API Shopee');
            return res.status(400).json({
                success: false,
                status: false,
                message: 'Token berhasil disimpan, tetapi API Shopee menolak token (Pastikan sesi partner web masih aktif)',
                data: { valid: false }
            });
        }
    } catch (err) {
        return res.status(500).json({
            success: false,
            status: false,
            message: 'Gagal verifikasi ke Shopee: ' + err.message
        });
    }
});

app.get('/api/shopee/token-status', apiKeyAuth, async (req, res) => {
    req.query.provider = 'SHOPEEPAY';
    return app._router.handle(req, res);
});

app.get(['/shopee/transactions', '/api/shopee/transactions'], apiKeyAuth, async (req, res) => {
    try {
        const days = req.query.days || req.query.range || 1;
        const pageSize = parseInt(req.query.pageSize || '30', 10);
        const mutations = await shopeeManager.getShopeeMutations(days, pageSize);
        res.json({
            success: true,
            provider: 'SHOPEEPAY',
            total_count: mutations.length,
            data: { transactions: mutations }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get(['/shopee/transactions/all', '/api/shopee/transactions/all'], apiKeyAuth, async (req, res) => {
    try {
        const mutations = await shopeeManager.getShopeeMutations(30, 100);
        res.json({
            success: true,
            provider: 'SHOPEEPAY',
            total_count: mutations.length,
            data: { transactions: mutations }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Logs Endpoint
app.get('/api/logs', apiKeyAuth, (req, res) => {
    res.json({ success: true, logs: activityLogs });
});

// Global error resilience: tangani unhandled exception & rejection agar daemon tidak crash
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    try {
        logActivity('ERROR', `Uncaught Exception: ${err.message}`);
    } catch (e) {}
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]', reason);
    try {
        const msg = reason && reason.message ? reason.message : String(reason);
        logActivity('WARNING', `Unhandled Rejection: ${msg}`);
    } catch (e) {}
});

// Start Server
app.listen(PORT, () => {
    shopeeManager.startTokenChecker();
    logActivity('SYSTEM', `BionPay Unified Gateway berjalan pada port ${PORT}`);
    logActivity('SYSTEM', `Developer & Merchant Dashboard: http://localhost:${PORT}/`);
    logActivity('SYSTEM', `Providers: GoPay (GoBiz) + ShopeePay Partner`);
    logActivity('SYSTEM', `Mode: ${process.env.SANDBOX_MODE === 'true' ? 'SANDBOX (Pengujian Lokal Aktif)' : 'PRODUCTION'}`);
});
