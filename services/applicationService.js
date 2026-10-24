'use strict';

const crypto = require('crypto');
const db = require('../database/db');
const { validateSafeUrl } = require('../utils/ssrf');

class ApplicationService {
    /**
     * Create a new Application (Website/Client)
     */
    async createApplication(data, actor = { type: 'ADMIN', id: 'admin' }, ip = '127.0.0.1') {
        const { name, website_url, description, provider_preference, webhook_url } = data;

        if (!name || name.trim().length === 0) {
            throw new Error('Nama aplikasi wajib diisi');
        }
        if (!website_url || website_url.trim().length === 0) {
            throw new Error('URL website aplikasi wajib diisi');
        }

        // Validate website URL
        await validateSafeUrl(website_url, true);

        // Validate webhook URL if provided
        if (webhook_url && webhook_url.trim().length > 0) {
            await validateSafeUrl(webhook_url, true);
        }

        const id = 'app_' + crypto.randomBytes(12).toString('hex');
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + id.substring(4, 10);
        const webhook_secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
        const pref = (provider_preference || 'AUTO').toUpperCase();

        if (!['GOPAY', 'SHOPEEPAY', 'AUTO'].includes(pref)) {
            throw new Error('Preferensi provider tidak valid (GOPAY, SHOPEEPAY, AUTO)');
        }

        const now = new Date().toISOString();

        await db.query(`
            INSERT INTO applications (id, name, slug, website_url, description, is_active, provider_preference, webhook_url, webhook_secret, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [id, name.trim(), slug, website_url.trim(), description || '', true, pref, webhook_url ? webhook_url.trim() : null, webhook_secret, now, now]);

        // Auto-generate initial Live & Sandbox API Keys
        const liveKey = await this.generateApiKey(id, 'Default Live Key', 'LIVE');
        const testKey = await this.generateApiKey(id, 'Default Sandbox Key', 'SANDBOX');

        // Audit Log
        await this.logAudit(id, actor.type, actor.id, 'APPLICATION_CREATED', 'application', id, { name, website_url }, ip);

        const app = await this.getApplicationById(id);
        return {
            ...app,
            initial_credentials: {
                live: liveKey,
                sandbox: testKey
            }
        };
    }

    /**
     * Retrieve all applications
     */
    async getAllApplications() {
        const res = await db.query(`SELECT * FROM applications ORDER BY created_at DESC`);
        const apps = res.rows || [];
        for (const app of apps) {
            const credsRes = await db.query(`
                SELECT id, application_id, name, key_type, api_key_prefix, permissions, is_active, last_used_at, created_at
                FROM api_credentials
                WHERE application_id = $1
                ORDER BY created_at DESC
            `, [app.id]);
            app.credentials = credsRes.rows || [];
            app.total_payments = 0;
            app.paid_payments = 0;
            app.total_volume = 0;
        }
        return apps;
    }

    /**
     * Get Application by ID
     */
    async getApplicationById(id) {
        const res = await db.query(`SELECT * FROM applications WHERE id = $1`, [id]);
        if (!res.rows || res.rows.length === 0) return null;
        const app = res.rows[0];

        // Fetch credentials
        const credsRes = await db.query(`
            SELECT id, application_id, name, key_type, api_key_prefix, permissions, is_active, last_used_at, created_at
            FROM api_credentials
            WHERE application_id = $1
            ORDER BY created_at DESC
        `, [id]);

        app.credentials = credsRes.rows;
        return app;
    }

    /**
     * Update Application Details
     */
    async updateApplication(id, data, actor = { type: 'ADMIN', id: 'admin' }, ip = '127.0.0.1') {
        const app = await this.getApplicationById(id);
        if (!app) throw new Error('Aplikasi tidak ditemukan');

        const { name, website_url, description, is_active, provider_preference, webhook_url } = data;

        if (website_url) await validateSafeUrl(website_url, true);
        if (webhook_url) await validateSafeUrl(webhook_url, true);

        const newName = name !== undefined ? name.trim() : app.name;
        const newUrl = website_url !== undefined ? website_url.trim() : app.website_url;
        const newDesc = description !== undefined ? description : app.description;
        const newActive = is_active !== undefined ? Boolean(is_active) : app.is_active;
        const newPref = provider_preference !== undefined ? provider_preference.toUpperCase() : app.provider_preference;
        const newWebhook = webhook_url !== undefined ? (webhook_url ? webhook_url.trim() : null) : app.webhook_url;
        const now = new Date().toISOString();

        await db.query(`
            UPDATE applications
            SET name = $1, website_url = $2, description = $3, is_active = $4, provider_preference = $5, webhook_url = $6, updated_at = $7
            WHERE id = $8
        `, [newName, newUrl, newDesc, newActive, newPref, newWebhook, now, id]);

        await this.logAudit(id, actor.type, actor.id, 'APPLICATION_UPDATED', 'application', id, data, ip);
        return this.getApplicationById(id);
    }

    /**
     * Generate API Key for Application (LIVE or SANDBOX)
     * Returns rawKey ONLY once.
     */
    async generateApiKey(applicationId, name, keyType = 'LIVE', permissions = ['payments:read', 'payments:write']) {
        const app = await this.getApplicationById(applicationId);
        if (!app) throw new Error('Aplikasi tidak ditemukan');

        const isLive = keyType.toUpperCase() === 'LIVE';
        const prefix = isLive ? 'bp_live_' : 'bp_test_';
        const rawToken = crypto.randomBytes(24).toString('hex');
        const rawKey = prefix + rawToken;
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const credId = 'key_' + crypto.randomBytes(12).toString('hex');
        const now = new Date().toISOString();

        await db.query(`
            INSERT INTO api_credentials (id, application_id, name, key_type, api_key_hash, api_key_prefix, permissions, is_active, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [credId, applicationId, name || (isLive ? 'Live Key' : 'Sandbox Key'), isLive ? 'LIVE' : 'SANDBOX', keyHash, rawKey.substring(0, 14), JSON.stringify(permissions), true, now]);

        return {
            id: credId,
            application_id: applicationId,
            name: name || (isLive ? 'Live Key' : 'Sandbox Key'),
            key_type: isLive ? 'LIVE' : 'SANDBOX',
            api_key: rawKey,
            raw_key: rawKey, // Displayed ONLY ONCE!
            prefix: rawKey.substring(0, 14),
            permissions,
            is_active: true,
            created_at: now
        };
    }

    /**
     * Revoke / Rotate API Key
     */
    async revokeApiKey(credentialId, applicationId, actor = { type: 'ADMIN', id: 'admin' }, ip = '127.0.0.1') {
        await db.query(`
            UPDATE api_credentials
            SET is_active = false
            WHERE id = $1 AND application_id = $2
        `, [credentialId, applicationId]);

        await this.logAudit(applicationId, actor.type, actor.id, 'API_KEY_REVOKED', 'api_credential', credentialId, {}, ip);
        return { success: true, message: 'API Key berhasil dinonaktifkan' };
    }

    /**
     * Rotate Webhook Secret for Application
     */
    async rotateWebhookSecret(applicationId, actor = { type: 'ADMIN', id: 'admin' }, ip = '127.0.0.1') {
        const newSecret = 'whsec_' + crypto.randomBytes(24).toString('hex');
        const now = new Date().toISOString();
        await db.query(`
            UPDATE applications
            SET webhook_secret = $1, updated_at = $2
            WHERE id = $3
        `, [newSecret, now, applicationId]);

        await this.logAudit(applicationId, actor.type, actor.id, 'WEBHOOK_SECRET_ROTATED', 'application', applicationId, {}, ip);
        return { success: true, webhook_secret: newSecret };
    }

    /**
     * Authenticate Incoming API Request via API Key
     */
    async authenticateApiKey(rawKey) {
        if (!rawKey || typeof rawKey !== 'string') return null;

        const trimmed = rawKey.trim();
        const keyHash = crypto.createHash('sha256').update(trimmed).digest('hex');

        const res = await db.query(`
            SELECT c.*, a.name as app_name, a.slug as app_slug, a.is_active as app_active, a.webhook_url, a.webhook_secret, a.provider_preference
            FROM api_credentials c
            JOIN applications a ON a.id = c.application_id
            WHERE c.api_key_hash = $1 AND c.is_active = true
        `, [keyHash]);

        if (!res.rows || res.rows.length === 0) return null;
        const cred = res.rows[0];

        if (!cred.app_active) {
            throw new Error('Aplikasi sedang dinonaktifkan oleh administrator');
        }

        // Update last used timestamp asynchronously
        db.query(`UPDATE api_credentials SET last_used_at = $1 WHERE id = $2`, [new Date().toISOString(), cred.id]).catch(() => {});

        let permissions = cred.permissions;
        if (typeof permissions === 'string') {
            try { permissions = JSON.parse(permissions); } catch (e) { permissions = []; }
        }

        return {
            credential_id: cred.id,
            application_id: cred.application_id,
            application_name: cred.app_name,
            application_slug: cred.app_slug,
            key_type: cred.key_type,
            is_sandbox: cred.key_type === 'SANDBOX',
            permissions: Array.isArray(permissions) ? permissions : [],
            provider_preference: cred.provider_preference || 'AUTO',
            webhook_url: cred.webhook_url,
            webhook_secret: cred.webhook_secret
        };
    }

    /**
     * Record an audit log
     */
    async logAudit(applicationId, actorType, actorId, action, entityType, entityId, details = {}, ip = '127.0.0.1') {
        const id = 'aud_' + crypto.randomBytes(12).toString('hex');
        const now = new Date().toISOString();
        await db.query(`
            INSERT INTO audit_logs (id, application_id, actor_type, actor_id, action, entity_type, entity_id, details, ip_address, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [id, applicationId, actorType, actorId, action, entityType, entityId, JSON.stringify(details), ip, now]);
    }
}

module.exports = new ApplicationService();
