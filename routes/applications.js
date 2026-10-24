'use strict';

const express = require('express');
const router = express.Router();
const applicationService = require('../services/applicationService');
const webhookService = require('../services/webhookService');
const reconciliationService = require('../services/reconciliationService');
const { requireAdmin } = require('../middleware/auth');
const db = require('../database/db');

// All routes here require master admin authorization
router.use(requireAdmin);

/**
 * GET /api/applications
 * List all integrated applications with telemetry metrics
 */
router.get('/applications', async (req, res) => {
    try {
        const apps = await applicationService.getAllApplications();
        res.json({
            success: true,
            data: apps
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/applications
 * Register a new external application/website
 */
router.post('/applications', async (req, res) => {
    const ip = req.ip || '127.0.0.1';
    try {
        const app = await applicationService.createApplication(req.body, req.adminActor, ip);
        res.status(201).json({
            success: true,
            message: 'Aplikasi berhasil didaftarkan',
            data: app
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/applications/:id
 * Retrieve details of an application
 */
router.get('/applications/:id', async (req, res) => {
    try {
        const app = await applicationService.getApplicationById(req.params.id);
        if (!app) {
            return res.status(404).json({ success: false, error: 'Aplikasi tidak ditemukan' });
        }
        res.json({ success: true, data: app });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * PUT /api/applications/:id
 * Update an existing application's settings
 */
router.put('/applications/:id', async (req, res) => {
    const ip = req.ip || '127.0.0.1';
    try {
        const updated = await applicationService.updateApplication(req.params.id, req.body, req.adminActor, ip);
        res.json({
            success: true,
            message: 'Aplikasi berhasil diperbarui',
            data: updated
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/applications/:id/keys
 * Generate a new API Key for an application
 */
router.post('/applications/:id/keys', async (req, res) => {
    const { name, key_type, permissions } = req.body;
    try {
        const key = await applicationService.generateApiKey(req.params.id, name, key_type, permissions);
        res.status(201).json({
            success: true,
            message: 'API Key berhasil dibuat. Simpan kunci ini sekarang karena tidak akan ditampilkan lagi!',
            data: key
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * DELETE /api/applications/:id/keys/:keyId
 * Revoke an API Key
 */
router.delete('/applications/:id/keys/:keyId', async (req, res) => {
    const ip = req.ip || '127.0.0.1';
    try {
        const result = await applicationService.revokeApiKey(req.params.keyId, req.params.id, req.adminActor, ip);
        res.json(result);
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/applications/:id/rotate-webhook-secret
 * Rotate webhook secret for an application
 */
router.post('/applications/:id/rotate-webhook-secret', async (req, res) => {
    const ip = req.ip || '127.0.0.1';
    try {
        const result = await applicationService.rotateWebhookSecret(req.params.id, req.adminActor, ip);
        res.json({
            success: true,
            message: 'Webhook signing secret berhasil diperbarui',
            data: result
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/applications/:id/test-webhook
 * Send a test webhook ping
 */
router.post('/applications/:id/test-webhook', async (req, res) => {
    try {
        const app = await applicationService.getApplicationById(req.params.id);
        if (!app || !app.webhook_url) {
            return res.status(400).json({ success: false, error: 'Aplikasi belum memiliki webhook_url yang terkonfigurasi' });
        }

        const testPayload = {
            test: true,
            message: 'BionPay Webhook Integration Test Ping',
            application_id: app.id,
            timestamp: new Date().toISOString()
        };

        const result = await webhookService.deliverWebhook('test_event_' + Date.now(), app.webhook_url, app.webhook_secret, 'webhook.test', testPayload, 1);
        res.json({
            success: result.success,
            message: result.success ? 'Test webhook berhasil terkirim (HTTP 2xx)' : `Gagal mengirim test webhook: ${result.error}`,
            details: result
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/applications/:id/audit-logs
 * View audit logs for an application
 */
router.get('/applications/:id/audit-logs', async (req, res) => {
    try {
        const logsRes = await db.query(`
            SELECT * FROM audit_logs
            WHERE application_id = $1
            ORDER BY created_at DESC
            LIMIT 100
        `, [req.params.id]);

        res.json({ success: true, data: logsRes.rows || [] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/reconciliation/unmatched
 * View unmatched / ambiguous provider transactions
 */
router.get('/reconciliation/unmatched', async (req, res) => {
    try {
        const unmatched = await reconciliationService.getUnmatchedSettlements(50);
        res.json({ success: true, data: unmatched });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/reconciliation/claim
 * Manual settlement claim by admin
 */
router.post('/reconciliation/claim', async (req, res) => {
    const { payment_id, provider_transaction_id, notes } = req.body;
    const ip = req.ip || '127.0.0.1';

    if (!payment_id || !provider_transaction_id) {
        return res.status(400).json({ success: false, error: 'payment_id dan provider_transaction_id diperlukan' });
    }

    try {
        const result = await reconciliationService.manualAdminClaim(payment_id, provider_transaction_id, req.adminActor.id, notes, ip);
        res.json(result);
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/reconciliation/match
 * Manually trigger reconciliation matching worker
 */
router.post('/reconciliation/match', async (req, res) => {
    try {
        const result = await reconciliationService.matchPendingPayments();
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/reconciliation/ingest
 * Ingest provider transaction
 */
router.post('/reconciliation/ingest', async (req, res) => {
    try {
        const tx = await reconciliationService.ingestProviderTransaction(req.body);
        res.status(201).json({ success: true, data: tx });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;
