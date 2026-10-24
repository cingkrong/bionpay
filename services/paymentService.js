'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../database/db');
const webhookService = require('./webhookService');
const { validateSafeUrl } = require('../utils/ssrf');

// Helper to compute EMVCo CRC16 Checksum
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

// Generate dynamic QRIS EMVCo string with full TLV parsing
function buildDynamicQris(staticTemplate, amount) {
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

class PaymentService {
    /**
     * Create a payment with Idempotency-Key support and EMVCo dynamic QRIS
     */
    async createPayment(appContext, data, idempotencyKey = null, baseUrl = 'http://localhost:3000') {
        const { application_id, is_sandbox } = appContext;
        const { order_id, amount, customer_name, customer_email, customer_phone, description, callback_url, return_url, provider, expires_in_minutes, metadata } = data;

        // 1. Validate Amount
        const numAmount = parseInt(amount, 10);
        if (!numAmount || isNaN(numAmount) || numAmount < 1) {
            throw { status: 400, code: 'INVALID_AMOUNT', message: 'Nominal pembayaran tidak valid (minimal Rp 1)' };
        }
        if (numAmount > 100000000) {
            throw { status: 400, code: 'AMOUNT_EXCEEDS_LIMIT', message: 'Nominal pembayaran melebihi batas maksimum per transaksi (Rp 100.000.000)' };
        }

        // 2. Validate Order ID
        if (!order_id || typeof order_id !== 'string' || order_id.trim().length === 0) {
            throw { status: 400, code: 'MISSING_ORDER_ID', message: 'order_id wajib disertakan dan berupa string unik per aplikasi' };
        }
        const cleanOrderId = order_id.trim();

        // 3. Check Idempotency Key
        if (idempotencyKey) {
            const rawBody = JSON.stringify(data);
            const requestHash = crypto.createHash('sha256').update(rawBody).digest('hex');

            const existingKeyRes = await db.query(`
                SELECT * FROM idempotency_records
                WHERE application_id = $1 AND idempotency_key = $2
            `, [application_id, idempotencyKey]);

            if (existingKeyRes.rows && existingKeyRes.rows.length > 0) {
                const record = existingKeyRes.rows[0];
                if (record.request_hash !== requestHash) {
                    throw { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency-Key sudah pernah digunakan dengan request payload yang berbeda' };
                }
                let cachedBody = record.response_body;
                if (typeof cachedBody === 'string') {
                    try { cachedBody = JSON.parse(cachedBody); } catch (e) {}
                }
                return { cached: true, ...cachedBody };
            }
        }

        // 4. Validate Duplicate Order ID for this Application
        const existingOrderRes = await db.query(`
            SELECT id, uuid, status, amount, order_id FROM payments
            WHERE application_id = $1 AND order_id = $2
        `, [application_id, cleanOrderId]);

        if (existingOrderRes.rows && existingOrderRes.rows.length > 0) {
            throw { status: 409, code: 'DUPLICATE_ORDER_ID', message: `Order ID '${cleanOrderId}' sudah pernah dibuat untuk aplikasi ini` };
        }

        // 5. Validate Callback & Return URLs against SSRF
        if (callback_url) {
            await validateSafeUrl(callback_url, is_sandbox);
        }
        if (return_url) {
            await validateSafeUrl(return_url, true);
        }

        // 6. Resolve Provider & Template
        const chosenProvider = (provider || appContext.provider_preference || 'AUTO').toUpperCase();
        if (!['GOPAY', 'SHOPEEPAY', 'AUTO'].includes(chosenProvider)) {
            throw { status: 400, code: 'INVALID_PROVIDER', message: 'Provider harus bernilai GOPAY, SHOPEEPAY, atau AUTO' };
        }

        // Fetch Static QRIS Template from env / provider accounts
        let staticTemplate = process.env.QRIS_STATIC || '';
        if (chosenProvider === 'SHOPEEPAY' && process.env.SHOPEE_QRIS_STATIC) {
            staticTemplate = process.env.SHOPEE_QRIS_STATIC;
        }

        // 7. Generate EMVCo Dynamic QRIS String
        const qrisCode = buildDynamicQris(staticTemplate, numAmount);
        const paymentId = 'pay_' + crypto.randomBytes(12).toString('hex');
        const uuid = crypto.randomUUID();

        // Expiry calculation: default 15 minutes
        const expMinutes = Math.min(Math.max(parseInt(expires_in_minutes || 15, 10), 1), 1440);
        const expiresAt = new Date(Date.now() + expMinutes * 60 * 1000).toISOString();
        const now = new Date().toISOString();

        const qrisImageUrl = `${baseUrl}/qr/${paymentId}/image.png`;
        const checkoutUrl = `${baseUrl}/checkout/${paymentId}`;

        // 8. Save Payment to Database
        await db.query(`
            INSERT INTO payments (
                id, uuid, application_id, provider, order_id, amount, currency, status,
                customer_name, customer_email, customer_phone, description,
                qris_code, qris_image_url, checkout_url, expires_at,
                callback_url, return_url, metadata, created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8,
                $9, $10, $11, $12,
                $13, $14, $15, $16,
                $17, $18, $19, $20, $21
            )
        `, [
            paymentId, uuid, application_id, chosenProvider, cleanOrderId, numAmount, 'IDR', 'PENDING',
            customer_name || null, customer_email || null, customer_phone || null, description || '',
            qrisCode, qrisImageUrl, checkoutUrl, expiresAt,
            callback_url || null, return_url || null, JSON.stringify(metadata || {}), now, now
        ]);

        const payment = await this.getPaymentById(paymentId, application_id);

        // 9. Store Idempotency Record if key was provided
        if (idempotencyKey) {
            const rawBody = JSON.stringify(data);
            const requestHash = crypto.createHash('sha256').update(rawBody).digest('hex');
            const idempId = 'idemp_' + crypto.randomBytes(12).toString('hex');
            const idempExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

            await db.query(`
                INSERT INTO idempotency_records (id, application_id, idempotency_key, request_hash, response_status, response_body, created_at, expires_at)
                VALUES ($1, $2, $3, $4, 201, $5, $6, $7)
            `, [idempId, application_id, idempotencyKey, requestHash, JSON.stringify(payment), now, idempExpiresAt]);
        }

        return payment;
    }

    /**
     * Get Payment by ID or UUID (Scoped by Application)
     */
    async getPaymentById(idOrUuid, applicationId = null) {
        let queryStr = `SELECT * FROM payments WHERE (id = $1 OR uuid = $1)`;
        const params = [idOrUuid];

        if (applicationId) {
            queryStr += ` AND application_id = $2`;
            params.push(applicationId);
        }

        const res = await db.query(queryStr, params);
        if (!res.rows || res.rows.length === 0) return null;

        const p = res.rows[0];

        // Format metadata
        if (typeof p.metadata === 'string') {
            try { p.metadata = JSON.parse(p.metadata); } catch (e) {}
        }

        // Fetch settlement claim if PAID
        if (p.status === 'PAID') {
            const claimRes = await db.query(`
                SELECT sc.*, pt.provider_transaction_id, pt.payer_issuer, pt.payment_type, pt.transaction_time
                FROM settlement_claims sc
                JOIN provider_transactions pt ON pt.id = sc.provider_transaction_id
                WHERE sc.payment_id = $1
            `, [p.id]);

            if (claimRes.rows && claimRes.rows.length > 0) {
                p.settlement = claimRes.rows[0];
            }
        }

        return p;
    }

    /**
     * List Payments with Pagination & Filters
     */
    async listPayments(applicationId, filters = {}) {
        const { status, limit = 20, offset = 0, start_date, end_date } = filters;
        const conditions = [`application_id = $1`];
        const params = [applicationId];
        let pIdx = 2;

        if (status && status !== 'ALL') {
            conditions.push(`status = $${pIdx}`);
            params.push(status.toUpperCase());
            pIdx++;
        }

        if (start_date) {
            conditions.push(`created_at >= $${pIdx}`);
            params.push(new Date(start_date).toISOString());
            pIdx++;
        }

        if (end_date) {
            conditions.push(`created_at <= $${pIdx}`);
            params.push(new Date(end_date).toISOString());
            pIdx++;
        }

        const whereSql = conditions.join(' AND ');
        const countRes = await db.query(`SELECT COUNT(*) as total FROM payments WHERE ${whereSql}`, params);
        const total = parseInt(countRes.rows[0]?.total || '0', 10);

        const safeLimit = Math.min(Math.max(parseInt(limit, 10), 1), 100);
        const safeOffset = Math.max(parseInt(offset, 10), 0);

        params.push(safeLimit);
        params.push(safeOffset);

        const itemsRes = await db.query(`
            SELECT * FROM payments
            WHERE ${whereSql}
            ORDER BY created_at DESC
            LIMIT $${pIdx} OFFSET $${pIdx + 1}
        `, params);

        return {
            total,
            limit: safeLimit,
            offset: safeOffset,
            data: itemsRes.rows || []
        };
    }

    /**
     * Cancel a Payment (Only CREATED or PENDING payments can be cancelled)
     */
    async cancelPayment(idOrUuid, applicationId) {
        const payment = await this.getPaymentById(idOrUuid, applicationId);
        if (!payment) {
            throw { status: 404, code: 'PAYMENT_NOT_FOUND', message: 'Pembayaran tidak ditemukan' };
        }

        if (payment.status === 'PAID') {
            throw { status: 400, code: 'PAYMENT_ALREADY_PAID', message: 'Pembayaran yang sudah lunas (PAID) tidak dapat dibatalkan' };
        }

        if (payment.status === 'CANCELLED') {
            return payment; // Idempotent
        }

        const now = new Date().toISOString();
        await db.query(`
            UPDATE payments
            SET status = 'CANCELLED', updated_at = $1
            WHERE id = $2
        `, [now, payment.id]);

        // Dispatch webhook
        webhookService.dispatchEvent(payment.application_id, payment.id, 'payment.cancelled', {
            event: 'payment.cancelled',
            payment_id: payment.id,
            order_id: payment.order_id,
            amount: parseInt(payment.amount, 10),
            status: 'CANCELLED'
        }).catch(() => {});

        return this.getPaymentById(payment.id, applicationId);
    }
}

module.exports = new PaymentService();
