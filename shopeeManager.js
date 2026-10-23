'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// User agents pool for anti-detection
const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
];

function randomUA() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

const statusMap = {
    1: 'pending',
    2: 'failed',
    3: 'success',
    4: 'refunded',
    5: 'expired'
};

const SHOPEE_LIST_URL = 'https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-list';
const SHOPEE_DETAIL_URL = 'https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-detail';

let currentShopeeToken = process.env.SHOPEE_TOKEN || '';
let isTokenValid = true;
let tokenNotifSent = false;
let lastCheckTime = 0;
let lastMerchantName = 'Bion Digital';
let lastStoreName = 'Bion Digital';

// Read dynamic SHOPEE_TOKEN from .env or memory
function getShopeeToken() {
    try {
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            const raw = fs.readFileSync(envPath, 'utf-8');
            const lines = raw.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('SHOPEE_TOKEN=')) {
                    const val = trimmed.substring('SHOPEE_TOKEN='.length).trim();
                    if (val && !val.startsWith('#')) {
                        currentShopeeToken = val;
                        return val;
                    }
                }
            }
        }
    } catch (e) {}
    return currentShopeeToken || process.env.SHOPEE_TOKEN || '';
}

// Update Shopee token and persist to .env
function updateShopeeToken(newToken) {
    if (!newToken || typeof newToken !== 'string') return false;
    currentShopeeToken = newToken.trim();
    isTokenValid = true;
    tokenNotifSent = false;

    try {
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            let content = fs.readFileSync(envPath, 'utf-8');
            if (/^SHOPEE_TOKEN=/m.test(content)) {
                content = content.replace(/^SHOPEE_TOKEN=.*$/m, `SHOPEE_TOKEN=${currentShopeeToken}`);
            } else {
                content += `\nSHOPEE_TOKEN=${currentShopeeToken}\n`;
            }
            fs.writeFileSync(envPath, content, 'utf-8');
        }
    } catch (e) {
        console.error('[ShopeeManager] Gagal menulis SHOPEE_TOKEN ke .env:', e.message);
    }
    return true;
}

// Send Telegram notification if configured
async function sendTelegramNotification(message) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;

    try {
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        }, { timeout: 10000 });
    } catch (err) {
        console.error('[ShopeeManager] Gagal mengirim notifikasi Telegram:', err.message);
    }
}

// Call ShopeePay Transaction List API
async function callShopeeAPI(startTime, endTime, pageSize = 20, nextPos = '', tokenOverride = null) {
    const token = tokenOverride || getShopeeToken();
    if (!token) return null;

    const payload = {
        data: {
            metadata: {
                token: token,
                language: 'id',
                timezone: 'Asia/Jakarta'
            },
            pageSize: pageSize,
            filter: {
                startTime: startTime,
                endTime: endTime,
                serviceList: [1, 3]
            },
            sorter: {
                field: 'createTime',
                order: 'descend'
            },
            next_position: nextPos || ''
        }
    };

    const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://partner.shopee.co.id',
        'Referer': 'https://partner.shopee.co.id/',
        'User-Agent': randomUA(),
        'X-Timestamp-Ms': String(Date.now())
    };

    const response = await axios.post(SHOPEE_LIST_URL, payload, { headers, timeout: 15000 });
    return response.data;
}

// Call ShopeePay Transaction Detail API to retrieve issuer (BCA, OVO, ShopeePay, etc.)
async function callShopeeDetailAPI(orderSN, tokenOverride = null) {
    const token = tokenOverride || getShopeeToken();
    if (!token || !orderSN) return null;

    const payload = {
        data: {
            metadata: {
                token: token,
                language: 'id',
                timezone: 'Asia/Jakarta'
            },
            order_sn: orderSN
        }
    };

    const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://partner.shopee.co.id',
        'Referer': 'https://partner.shopee.co.id/',
        'User-Agent': randomUA(),
        'X-Timestamp-Ms': String(Date.now())
    };

    const response = await axios.post(SHOPEE_DETAIL_URL, payload, { headers, timeout: 15000 });
    return response.data;
}

// Format raw Shopee transaction into unified model
function formatShopeeTransaction(t) {
    const date = new Date(t.createTime * 1000);
    const offset = 7 * 60; // WIB UTC+7
    const wibTime = new Date(date.getTime() + offset * 60 * 1000);

    const pad = (n) => String(n).padStart(2, '0');
    const formattedTime = `${wibTime.getUTCFullYear()}-${pad(wibTime.getUTCMonth() + 1)}-${pad(wibTime.getUTCDate())} ${pad(wibTime.getUTCHours())}:${pad(wibTime.getUTCMinutes())}:${pad(wibTime.getUTCSeconds())}`;

    let cleanAmount = String(t.amount || '0').replace(/\./g, '').replace(/,/g, '');
    const amount = parseInt(cleanAmount, 10) || 0;
    const status = statusMap[t.status] || `status_${t.status}`;

    return {
        id: t.transactionId || t.displayTransactionId || t.order_sn || '',
        order_id: t.displayTransactionId || t.transactionId || '',
        amount: amount,
        status: status === 'success' ? 'SETTLEMENT' : status.toUpperCase(),
        time: formattedTime,
        timestamp: t.createTime * 1000,
        issuer: 'ShopeePay / QRIS',
        provider: 'SHOPEEPAY'
    };
}

// Periodic check of token status
async function checkShopeeToken() {
    const token = getShopeeToken();
    if (!token) {
        isTokenValid = false;
        return false;
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    const startUnix = nowUnix - 7 * 86400; // Cek window 7 hari terakhir agar mutasi & info merchant terambil

    try {
        const result = await callShopeeAPI(startUnix, nowUnix, 5, '', token);
        if (!result || result.code !== 0) {
            const errMsg = result ? (result.msg || `Error code ${result.code}`) : 'Empty response';
            isTokenValid = false;
            if (!tokenNotifSent) {
                tokenNotifSent = true;
                await sendTelegramNotification(`⚠️ <b>[BionPay Alert]</b> ShopeePay Token kedaluwarsa atau tidak valid!\nDetail: ${errMsg}\nSilakan perbarui SHOPEE_TOKEN di Dashboard.`);
            }
            return false;
        }

        if (result.data && result.data.list && result.data.list.length > 0) {
            const first = result.data.list[0];
            if (first.merchantName) lastMerchantName = first.merchantName;
            if (first.storeName) lastStoreName = first.storeName;
        }

        isTokenValid = true;
        tokenNotifSent = false;
        lastCheckTime = Date.now();
        return true;
    } catch (err) {
        isTokenValid = false;
        if (!tokenNotifSent) {
            tokenNotifSent = true;
            await sendTelegramNotification(`⚠️ <b>[BionPay Alert]</b> Gagal memeriksa ShopeePay Token: ${err.message}`);
        }
        return false;
    }
}

// Start periodic token check every 5 minutes
function startTokenChecker(intervalMs = 5 * 60 * 1000) {
    if (getShopeeToken()) {
        checkShopeeToken().catch(() => {});
        setInterval(() => {
            checkShopeeToken().catch(() => {});
        }, intervalMs);
    }
}

// Verify payment for ShopeePay (called by core check-payment & auto-matcher)
async function verifyShopeePayment(amount, startTime, scopeId = null, tokenOverride = null) {
    const token = tokenOverride || getShopeeToken();
    if (!token) return null;

    const targetAmount = parseInt(amount, 10);
    const nowUnix = Math.floor(Date.now() / 1000);

    let startUnix;
    if (startTime) {
        startUnix = Math.floor(new Date(startTime).getTime() / 1000) - 120; // toleransi clock skew 2 menit
    } else {
        startUnix = nowUnix - 30 * 60; // default 30 menit
    }

    const result = await callShopeeAPI(startUnix, nowUnix, 50, '', token);
    if (!result || result.code !== 0) {
        return null;
    }

    const list = (result.data && result.data.list) || [];

    for (const item of list) {
        let cleanAmount = String(item.amount || '0').replace(/\./g, '').replace(/,/g, '');
        const txAmount = parseInt(cleanAmount, 10) || 0;
        const txId = item.transactionId || item.displayTransactionId;

        // Status 3 = success settlement
        if (item.status === 3 && txAmount === targetAmount && item.createTime >= startUnix) {
            let issuer = 'ShopeePay / QRIS';
            try {
                const detail = await callShopeeDetailAPI(item.displayTransactionId || item.transactionId, token);
                if (detail && detail.code === 0 && detail.data && detail.data.issuer) {
                    issuer = detail.data.issuer;
                }
            } catch (e) {}

            const formatted = formatShopeeTransaction(item);
            formatted.issuer = issuer;

            return {
                transaction_id: txId,
                order_id: item.displayTransactionId || item.transactionId || '',
                amount: txAmount,
                payer_issuer: issuer,
                payment_type: 'SHOPEEPAY_QRIS',
                transaction_time: formatted.time,
                provider: 'SHOPEEPAY'
            };
        }
    }

    return null;
}

// Get live mutations list from ShopeePay with enriched details (issuer, RRN, merchant name)
async function getShopeeMutations(rangeDays = 7, pageSize = 50) {
    const token = getShopeeToken();
    if (!token) return [];

    const now = Math.floor(Date.now() / 1000);
    const days = parseInt(rangeDays, 10) || 7;
    const startTime = now - days * 24 * 3600;

    try {
        const result = await callShopeeAPI(startTime, now, pageSize, '', token);
        if (!result || result.code !== 0) return [];

        const list = (result.data && result.data.list) || [];
        
        // Enrich top 30 transactions with detailed issuer & reference id
        const enriched = await Promise.all(list.slice(0, 30).map(async (t) => {
            const formatted = formatShopeeTransaction(t);
            let issuer = 'ShopeePay / QRIS';
            let rrn = t.externalTransactionId || '-';
            try {
                const detail = await callShopeeDetailAPI(t.displayTransactionId || t.transactionId, token);
                if (detail && detail.code === 0 && detail.data) {
                    if (detail.data.issuer) issuer = detail.data.issuer;
                    if (detail.data.reference_id) rrn = detail.data.reference_id;
                }
            } catch (e) {}

            return {
                id: formatted.id,
                transaction_id: formatted.id,
                order_id: formatted.order_id,
                amount: formatted.amount,
                status: formatted.status,
                issuer: issuer,
                merchant_name: t.merchantName || t.storeName || lastMerchantName || 'Bion Digital',
                time: formatted.time,
                timestamp: formatted.timestamp,
                channel: 'SHOPEEPAY_QR',
                rrn: rrn,
                provider: 'SHOPEEPAY'
            };
        }));

        const remaining = list.slice(30).map(t => {
            const formatted = formatShopeeTransaction(t);
            return {
                id: formatted.id,
                transaction_id: formatted.id,
                order_id: formatted.order_id,
                amount: formatted.amount,
                status: formatted.status,
                issuer: 'ShopeePay / QRIS',
                merchant_name: t.merchantName || t.storeName || lastMerchantName || 'Bion Digital',
                time: formatted.time,
                timestamp: formatted.timestamp,
                channel: 'SHOPEEPAY_QR',
                rrn: t.externalTransactionId || '-',
                provider: 'SHOPEEPAY'
            };
        });

        return [...enriched, ...remaining];
    } catch (e) {
        return [];
    }
}

function getShopeeStatus() {
    const token = getShopeeToken();
    const hasToken = Boolean(token && token.trim().length > 0);
    return {
        configured: hasToken,
        valid: hasToken && isTokenValid,
        merchant_name: lastMerchantName || lastStoreName || (hasToken && isTokenValid ? 'Bion Digital' : null),
        store_name: lastStoreName || 'Bion Digital',
        expiry: null,
        last_checked: lastCheckTime ? new Date(lastCheckTime).toISOString() : null
    };
}

module.exports = {
    getShopeeToken,
    updateShopeeToken,
    isTokenValid: () => isTokenValid,
    getShopeeStatus,
    checkShopeeToken,
    startTokenChecker,
    callShopeeAPI,
    callShopeeDetailAPI,
    verifyShopeePayment,
    getShopeeMutations,
    formatShopeeTransaction
};
