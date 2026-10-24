'use strict';

const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');
const webhookService = require('../services/webhookService');
const { requireApiKey } = require('../middleware/auth');
const { rateLimiter } = require('../middleware/rateLimiter');
const db = require('../database/db');

// Apply rate limiter to V1 API
router.use(rateLimiter({ windowMs: 60 * 1000, max: 180, prefix: 'v1_api' }));

/**
 * GET /v1/health
 * Public or API Key health telemetry
 */
router.get('/health', async (req, res) => {
    const isDbConnected = db.isPostgres();
    res.json({
        success: true,
        data: {
            service: 'BionPay Unified Integration Gateway',
            version: '2.0.0',
            api_version: 'v1',
            status: 'HEALTHY',
            database: isDbConnected ? 'POSTGRESQL' : 'TRANSACTIONAL_PERSISTENT',
            timestamp: new Date().toISOString()
        }
    });
});

/**
 * POST /v1/payments
 * Create a new dynamic QRIS payment session
 * Header: X-API-Key, Idempotency-Key (optional but recommended)
 */
router.post('/payments', requireApiKey('payments:write'), async (req, res) => {
    const idempotencyKey = req.headers['idempotency-key'] || null;
    const origin = `${req.protocol}://${req.get('host')}`;

    try {
        const payment = await paymentService.createPayment(req.appContext, req.body, idempotencyKey, origin);
        res.status(payment.cached ? 200 : 201).json({
            success: true,
            data: payment
        });
    } catch (err) {
        const status = err.status || 500;
        const code = err.code || 'INTERNAL_ERROR';
        const message = err.message || 'Terjadi kesalahan pada server';
        res.status(status).json({
            success: false,
            error: { code, message }
        });
    }
});

/**
 * GET /v1/payments/:id
 * Retrieve a payment by ID or UUID
 */
router.get('/payments/:id', requireApiKey('payments:read'), async (req, res) => {
    try {
        const payment = await paymentService.getPaymentById(req.params.id, req.appContext.application_id);
        if (!payment) {
            return res.status(404).json({
                success: false,
                error: {
                    code: 'PAYMENT_NOT_FOUND',
                    message: `Pembayaran '${req.params.id}' tidak ditemukan untuk aplikasi Anda`
                }
            });
        }
        res.json({
            success: true,
            data: payment
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: { code: 'INTERNAL_ERROR', message: err.message }
        });
    }
});

/**
 * GET /v1/payments
 * List payments for the authenticated application with pagination and filters
 */
router.get('/payments', requireApiKey('payments:read'), async (req, res) => {
    try {
        const result = await paymentService.listPayments(req.appContext.application_id, {
            status: req.query.status,
            limit: req.query.limit,
            offset: req.query.offset,
            start_date: req.query.start_date,
            end_date: req.query.end_date
        });

        res.json({
            success: true,
            pagination: {
                total: result.total,
                limit: result.limit,
                offset: result.offset
            },
            data: result.data
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: { code: 'INTERNAL_ERROR', message: err.message }
        });
    }
});

/**
 * POST /v1/payments/:id/cancel
 * Cancel a pending payment
 */
router.post('/payments/:id/cancel', requireApiKey('payments:write'), async (req, res) => {
    try {
        const cancelled = await paymentService.cancelPayment(req.params.id, req.appContext.application_id);
        res.json({
            success: true,
            data: cancelled
        });
    } catch (err) {
        const status = err.status || 500;
        const code = err.code || 'CANCEL_FAILED';
        res.status(status).json({
            success: false,
            error: { code, message: err.message }
        });
    }
});

/**
 * POST /v1/payment-links
 * Create a payment link that redirects directly to hosted checkout
 */
router.post('/payment-links', requireApiKey('payments:write'), async (req, res) => {
    const idempotencyKey = req.headers['idempotency-key'] || null;
    const origin = `${req.protocol}://${req.get('host')}`;

    try {
        const payment = await paymentService.createPayment(req.appContext, req.body, idempotencyKey, origin);
        res.status(201).json({
            success: true,
            data: {
                payment_id: payment.id,
                order_id: payment.order_id,
                amount: payment.amount,
                payment_link: payment.checkout_url,
                expires_at: payment.expires_at,
                status: payment.status
            }
        });
    } catch (err) {
        const status = err.status || 500;
        res.status(status).json({
            success: false,
            error: { code: err.code || 'LINK_CREATION_FAILED', message: err.message }
        });
    }
});

/**
 * GET /v1/webhook-events
 * List webhook events dispatched for this application
 */
router.get('/webhook-events', requireApiKey('payments:read'), async (req, res) => {
    try {
        const resDb = await db.query(`
            SELECT e.*, 
                (SELECT json_agg(d.*) FROM webhook_deliveries d WHERE d.webhook_event_id = e.id) as deliveries
            FROM webhook_events e
            WHERE e.application_id = $1
            ORDER BY e.created_at DESC
            LIMIT 50
        `, [req.appContext.application_id]);

        res.json({
            success: true,
            data: resDb.rows || []
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: { code: 'INTERNAL_ERROR', message: err.message }
        });
    }
});

/**
 * POST /v1/webhook-events/:id/retry
 * Manually trigger webhook retry
 */
router.post('/webhook-events/:id/retry', requireApiKey('payments:write'), async (req, res) => {
    try {
        const result = await webhookService.manualRetry(req.params.id);
        res.json({
            success: true,
            message: 'Webhook retry telah dikirim',
            result
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            error: { code: 'RETRY_FAILED', message: err.message }
        });
    }
});

module.exports = router;
