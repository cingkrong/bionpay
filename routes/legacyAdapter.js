'use strict';

const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');
const reconciliationService = require('../services/reconciliationService');
const applicationService = require('../services/applicationService');
const { requireApiKey, requireAdmin } = require('../middleware/auth');
const db = require('../database/db');

/**
 * Legacy Adapter: POST /create-qris and POST /api/qris/create
 * Translates legacy request format to PaymentService
 */
router.all(['/create-qris', '/api/qris/create'], requireApiKey('payments:write'), async (req, res) => {
    let rawAmount = req.body?.amount || req.query?.amount;
    if (typeof rawAmount === 'string') {
        rawAmount = rawAmount.replace(/[^0-9]/g, '');
    }
    const amount = parseInt(rawAmount, 10);
    const order_id = req.body?.order_id || req.query?.order_id || ('LEGACY-' + Date.now().toString(36).toUpperCase());
    const callback_url = req.body?.callback_url || req.query?.callback_url || null;
    const return_url = req.body?.return_url || req.query?.return_url || null;
    const provider = req.body?.provider || req.query?.provider || 'AUTO';

    const origin = `${req.protocol}://${req.get('host')}`;

    try {
        const payment = await paymentService.createPayment(req.appContext, {
            order_id,
            amount,
            callback_url,
            return_url,
            provider
        }, req.headers['idempotency-key'] || null, origin);

        // Format in legacy response schema for 100% backward compatibility
        res.json({
            success: true,
            status: 'success',
            message: 'QRIS Dinamis berhasil dibuat',
            data: {
                qris_id: payment.id,
                trx_id: payment.id,
                order_id: payment.order_id,
                amount: parseInt(payment.amount, 10),
                provider: payment.provider,
                qris_code: payment.qris_code,
                qris_url: payment.checkout_url,
                qr_image_url: payment.qris_image_url,
                checkout_url: payment.checkout_url,
                expires_at: payment.expires_at,
                expires_in: '15 menit'
            }
        });
    } catch (err) {
        res.status(err.status || 500).json({
            success: false,
            status: 'error',
            message: err.message
        });
    }
});

/**
 * Legacy Adapter: /check-payment
 * Verifies payment against settlement claims & triggers auto-reconciliation
 */
router.all('/check-payment', requireApiKey('payments:read'), async (req, res) => {
    const rawAmount = req.body?.amount || req.query?.amount;
    const trxId = req.body?.trx_id || req.query?.trx_id || null;
    const orderId = req.body?.order_id || req.query?.order_id || null;

    if (!rawAmount || isNaN(rawAmount)) {
        return res.status(400).json({ success: false, message: 'Nominal pembayaran tidak valid' });
    }
    const amount = parseInt(rawAmount, 10);

    try {
        // Run settlement matching
        await reconciliationService.matchPendingPayments();

        let payment = null;
        if (trxId) {
            payment = await paymentService.getPaymentById(trxId, req.appContext.application_id);
        } else if (orderId) {
            const resDb = await db.query(`SELECT * FROM payments WHERE application_id = $1 AND order_id = $2`, [req.appContext.application_id, orderId]);
            if (resDb.rows && resDb.rows.length > 0) {
                payment = await paymentService.getPaymentById(resDb.rows[0].id, req.appContext.application_id);
            }
        } else {
            // Find most recent payment for this amount
            const resDb = await db.query(`
                SELECT * FROM payments
                WHERE application_id = $1 AND amount = $2
                ORDER BY created_at DESC
                LIMIT 1
            `, [req.appContext.application_id, amount]);
            if (resDb.rows && resDb.rows.length > 0) {
                payment = await paymentService.getPaymentById(resDb.rows[0].id, req.appContext.application_id);
            }
        }

        if (payment && payment.status === 'PAID') {
            return res.json({
                success: true,
                paid: true,
                transaction: payment.settlement ? {
                    transaction_id: payment.settlement.provider_transaction_id,
                    order_id: payment.order_id,
                    amount: parseInt(payment.amount, 10),
                    payer_issuer: payment.settlement.payer_issuer,
                    payment_type: payment.settlement.payment_type,
                    transaction_time: payment.settlement.transaction_time
                } : {
                    transaction_id: payment.id,
                    amount: parseInt(payment.amount, 10),
                    status: 'PAID'
                }
            });
        }

        res.json({
            success: true,
            paid: false,
            message: 'Pembayaran belum ditemukan atau belum diverifikasi masuk ke settlement'
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error checking payment: ' + err.message });
    }
});

module.exports = router;
