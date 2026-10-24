'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const paymentService = require('../services/paymentService');
const applicationService = require('../services/applicationService');
const db = require('../database/db');

/**
 * GET /checkout/:id
 * Render responsive hosted checkout page
 */
router.get(['/checkout/:id', '/qr/:id'], async (req, res) => {
    const paymentId = req.params.id;
    const checkoutViewPath = path.join(__dirname, '..', 'views', 'checkout.html');

    if (!fs.existsSync(checkoutViewPath)) {
        return res.status(404).send('Checkout view template not found');
    }

    try {
        let payment = await paymentService.getPaymentById(paymentId);
        let app = null;

        if (payment) {
            app = await applicationService.getApplicationById(payment.application_id);
        }

        if (!payment) {
            // Check fallback legacy store if present
            const storeRes = await db.query(`SELECT * FROM payments WHERE id = $1 OR uuid = $1`, [paymentId]);
            if (storeRes.rows && storeRes.rows.length > 0) {
                payment = storeRes.rows[0];
            }
        }

        if (!payment) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head><title>Tagihan Tidak Ditemukan</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
                <body style="background:#090d16;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                    <div style="text-align:center;padding:24px;">
                        <h2 style="margin-bottom:8px;">Tagihan Pembayaran Tidak Ditemukan</h2>
                        <p style="color:#94a3b8;font-size:14px;">Sesi QRIS tidak ditemukan atau telah dihapus.</p>
                    </div>
                </body>
                </html>
            `);
        }

        const merchantName = (app && app.name) ? app.name : (process.env.GOPAY_MERCHANT_NAME || 'BionPay Merchant');
        const formattedAmount = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(payment.amount);
        const expiresMs = new Date(payment.expires_at).getTime();
        const origin = `${req.protocol}://${req.get('host')}`;
        const qrImgUrl = `${origin}/qr/${payment.id}/image.png`;

        let html = fs.readFileSync(checkoutViewPath, 'utf-8');
        html = html
            .replace(/{{MERCHANT_NAME}}/g, merchantName)
            .replace(/{{FORMATTED_AMOUNT}}/g, formattedAmount)
            .replace(/{{AMOUNT_RAW}}/g, String(payment.amount))
            .replace(/{{EXPIRES_TIMESTAMP}}/g, String(expiresMs))
            .replace(/{{QR_IMG_URL}}/g, qrImgUrl)
            .replace(/{{TRX_ID}}/g, payment.id)
            .replace(/{{ORDER_ID}}/g, payment.order_id || payment.id)
            .replace(/{{RAW_STRING}}/g, payment.qris_code || '')
            .replace(/{{QRIS_ID}}/g, payment.id)
            .replace(/{{RETURN_URL}}/g, payment.return_url || '')
            .replace(/{{BRAND_COLOR}}/g, '#00aed9')
            .replace(/{{BRAND_COLOR_END}}/g, '#10b981');

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (err) {
        res.status(500).send('Error rendering checkout: ' + err.message);
    }
});

/**
 * GET /api/qr-status/:id and GET /checkout/:id/status
 * Public status polling endpoint (Strictly exposes NO SECRETS!)
 */
router.get(['/api/qr-status/:id', '/checkout/:id/status'], async (req, res) => {
    const paymentId = req.params.id;

    try {
        const payment = await paymentService.getPaymentById(paymentId);
        if (!payment) {
            return res.status(404).json({ success: false, paid: false, status: 'NOT_FOUND', message: 'Sesi tidak ditemukan' });
        }

        const isPaid = payment.status === 'PAID';
        const isExpired = payment.status === 'EXPIRED' || (new Date(payment.expires_at).getTime() < Date.now() && !isPaid);

        res.json({
            success: true,
            paid: isPaid,
            status: isPaid ? 'PAID' : (isExpired ? 'EXPIRED' : payment.status),
            amount: parseInt(payment.amount, 10),
            order_id: payment.order_id,
            return_url: payment.return_url || null,
            transaction: payment.settlement ? {
                transaction_id: payment.settlement.provider_transaction_id,
                payer_issuer: payment.settlement.payer_issuer,
                payment_type: payment.settlement.payment_type,
                transaction_time: payment.settlement.transaction_time
            } : null
        });
    } catch (err) {
        res.status(500).json({ success: false, paid: false, error: err.message });
    }
});

/**
 * GET /qr/:id/image.png
 * Generate raw PNG QR Code image on the fly
 */
router.get('/qr/:id/image.png', async (req, res) => {
    const paymentId = req.params.id;

    try {
        const payment = await paymentService.getPaymentById(paymentId);
        if (!payment || !payment.qris_code) {
            return res.status(404).send('QRIS payload not found');
        }

        const qrBuffer = await QRCode.toBuffer(payment.qris_code, {
            type: 'png',
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 380,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.send(qrBuffer);
    } catch (err) {
        res.status(500).send('Error generating QR image');
    }
});

module.exports = router;
