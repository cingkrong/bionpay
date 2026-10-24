'use strict';

const axios = require('axios');
const crypto = require('crypto');
const db = require('../database/db');
const { validateSafeUrl } = require('../utils/ssrf');

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_SECONDS = [10, 30, 120, 600, 1800]; // 10s, 30s, 2m, 10m, 30m

class WebhookService {
    /**
     * Dispatch an event to application webhooks
     */
    async dispatchEvent(applicationId, paymentId, eventType, payload) {
        // Fetch application details & webhook secret
        const appRes = await db.query(`SELECT id, name, webhook_url, webhook_secret, is_active FROM applications WHERE id = $1`, [applicationId]);
        if (!appRes.rows || appRes.rows.length === 0) return null;
        const app = appRes.rows[0];

        // Also check if any custom webhook_endpoints are subscribed to this event
        const endpointsRes = await db.query(`SELECT * FROM webhook_endpoints WHERE application_id = $1 AND is_active = true`, [applicationId]);
        const targetEndpoints = [];

        // Primary application webhook URL
        if (app.webhook_url && app.webhook_url.trim().length > 0) {
            targetEndpoints.push({
                url: app.webhook_url.trim(),
                secret: app.webhook_secret
            });
        }

        // Additional registered endpoints
        for (const ep of endpointsRes.rows || []) {
            let events = ep.subscribed_events;
            if (typeof events === 'string') {
                try { events = JSON.parse(events); } catch (e) { events = []; }
            }
            if (Array.isArray(events) && events.includes(eventType)) {
                if (!targetEndpoints.some(t => t.url === ep.url)) {
                    targetEndpoints.push({
                        url: ep.url,
                        secret: ep.secret || app.webhook_secret
                    });
                }
            }
        }

        if (targetEndpoints.length === 0) {
            // No endpoints configured, save event record as pending/logged
            const eventId = 'whev_' + crypto.randomBytes(12).toString('hex');
            await db.query(`
                INSERT INTO webhook_events (id, application_id, payment_id, event_type, payload, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [eventId, applicationId, paymentId, eventType, JSON.stringify(payload), 'DELIVERED', new Date().toISOString()]);
            return { event_id: eventId, delivered: false, reason: 'No webhook endpoints configured' };
        }

        const eventId = 'whev_' + crypto.randomBytes(12).toString('hex');
        const now = new Date().toISOString();

        // Create Webhook Event record
        await db.query(`
            INSERT INTO webhook_events (id, application_id, payment_id, event_type, payload, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [eventId, applicationId, paymentId, eventType, JSON.stringify(payload), 'PENDING', now]);

        // Dispatch to all target endpoints
        for (const endpoint of targetEndpoints) {
            await this.deliverWebhook(eventId, endpoint.url, endpoint.secret, eventType, payload, 1);
        }

        return { event_id: eventId, dispatched_to: targetEndpoints.length };
    }

    /**
     * Deliver Webhook Payload with HMAC-SHA256 signature
     */
    async deliverWebhook(eventId, targetUrl, secret, eventType, payload, attemptNumber = 1) {
        const deliveryId = 'whdel_' + crypto.randomBytes(12).toString('hex');
        const timestamp = Math.floor(Date.now() / 1000);

        const eventEnvelope = {
            id: eventId,
            event: eventType,
            created_at: new Date().toISOString(),
            data: payload
        };

        const rawBody = JSON.stringify(eventEnvelope);
        // Signature calculated over: timestamp.rawBody
        const signaturePayload = `${timestamp}.${rawBody}`;
        const signature = crypto.createHmac('sha256', secret).update(signaturePayload).digest('hex');

        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'BionPay-Webhook-Dispatcher/2.0',
            'X-BionPay-Signature': `sha256=${signature}`,
            'X-BionPay-Timestamp': String(timestamp),
            'X-BionPay-Event-Id': eventId,
            'X-BionPay-Event': eventType,
            'X-BionPay-Delivery': deliveryId
        };

        const startTime = Date.now();
        let status = null;
        let responseBody = null;
        let errorMessage = null;

        try {
            // SSRF validation
            await validateSafeUrl(targetUrl, process.env.SANDBOX_MODE === 'true');

            const res = await axios.post(targetUrl, rawBody, {
                headers,
                timeout: 8000,
                maxRedirects: 0,
                validateStatus: (s) => true // Don't throw on HTTP error codes so we can record them
            });

            status = res.status;
            responseBody = typeof res.data === 'string' ? res.data.substring(0, 1000) : JSON.stringify(res.data).substring(0, 1000);

            if (status >= 200 && status < 300) {
                // Success!
                const duration = Date.now() - startTime;
                await db.query(`
                    INSERT INTO webhook_deliveries (id, webhook_event_id, endpoint_url, attempt_number, request_headers, request_body, response_status, response_body, delivery_time_ms, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `, [deliveryId, eventId, targetUrl, attemptNumber, JSON.stringify(headers), rawBody, status, responseBody, duration, new Date().toISOString()]);

                await db.query(`UPDATE webhook_events SET status = 'DELIVERED' WHERE id = $1`, [eventId]);
                return { success: true, status };
            } else {
                errorMessage = `HTTP ${status}`;
            }
        } catch (err) {
            errorMessage = err.message;
        }

        const duration = Date.now() - startTime;

        // Schedule Retry with Exponential Backoff
        const isFinalAttempt = attemptNumber >= MAX_RETRY_ATTEMPTS;
        let nextRetryAt = null;

        if (!isFinalAttempt) {
            const delaySec = RETRY_DELAYS_SECONDS[attemptNumber - 1] || 1800;
            nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString();
        }

        await db.query(`
            INSERT INTO webhook_deliveries (id, webhook_event_id, endpoint_url, attempt_number, request_headers, request_body, response_status, response_body, error_message, delivery_time_ms, next_retry_at, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [deliveryId, eventId, targetUrl, attemptNumber, JSON.stringify(headers), rawBody, status, responseBody, errorMessage, duration, nextRetryAt, new Date().toISOString()]);

        if (isFinalAttempt) {
            await db.query(`UPDATE webhook_events SET status = 'DEAD_LETTER' WHERE id = $1`, [eventId]);
        } else {
            await db.query(`UPDATE webhook_events SET status = 'FAILED' WHERE id = $1`, [eventId]);
        }

        return { success: false, error: errorMessage, next_retry_at: nextRetryAt };
    }

    /**
     * Process pending retries from persistent delivery queue
     */
    async processRetryQueue() {
        const now = new Date().toISOString();
        const res = await db.query(`
            SELECT d.*, e.event_type, e.payload, e.application_id, a.webhook_secret
            FROM webhook_deliveries d
            JOIN webhook_events e ON e.id = d.webhook_event_id
            JOIN applications a ON a.id = e.application_id
            WHERE d.next_retry_at IS NOT NULL AND d.next_retry_at <= $1 AND e.status = 'FAILED'
        `, [now]);

        for (const item of res.rows || []) {
            // Clear scheduled retry to prevent duplicate workers
            await db.query(`UPDATE webhook_deliveries SET next_retry_at = NULL WHERE id = $1`, [item.id]);
            let payload = item.payload;
            if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); } catch (e) {}
            }
            await this.deliverWebhook(item.webhook_event_id, item.endpoint_url, item.webhook_secret, item.event_type, payload, item.attempt_number + 1);
        }
    }

    /**
     * Manual Retry for a specific Webhook Event
     */
    async manualRetry(eventId) {
        const evRes = await db.query(`
            SELECT e.*, a.webhook_url, a.webhook_secret
            FROM webhook_events e
            JOIN applications a ON a.id = e.application_id
            WHERE e.id = $1
        `, [eventId]);

        if (!evRes.rows || evRes.rows.length === 0) {
            throw new Error('Event webhook tidak ditemukan');
        }

        const ev = evRes.rows[0];
        if (!ev.webhook_url) {
            throw new Error('Aplikasi tidak memiliki webhook_url yang terkonfigurasi');
        }

        let payload = ev.payload;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (e) {}
        }

        return this.deliverWebhook(ev.id, ev.webhook_url, ev.webhook_secret, ev.event_type, payload, 1);
    }
}

const webhookService = new WebhookService();

// Run retry queue worker every 15 seconds
setInterval(() => {
    webhookService.processRetryQueue().catch(() => {});
}, 15000);

module.exports = webhookService;
