'use strict';

const crypto = require('crypto');
const applicationService = require('../services/applicationService');

/**
 * Timing-safe string comparison
 */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware: Scoped API Key Authentication for REST API V1 & Integrations
 * Reads strictly from 'X-API-Key' or 'Authorization: Bearer <key>'
 */
const requireApiKey = (requiredPermission = null) => {
    return async (req, res, next) => {
        let rawKey = req.headers['x-api-key'];

        if (!rawKey && req.headers.authorization) {
            const parts = req.headers.authorization.split(' ');
            if (parts.length === 2 && (parts[0] === 'Bearer' || parts[0] === 'ApiKey')) {
                rawKey = parts[1];
            }
        }

        // Backward compatibility for legacy clients sending query params in dev only
        if (!rawKey && process.env.SANDBOX_MODE === 'true' && (req.query.api_key || req.query.apikey)) {
            rawKey = req.query.api_key || req.query.apikey;
            console.warn('⚠️ [SECURITY DEPRECATION] API key passed via query parameter. Please migrate to X-API-Key header.');
        }

        if (!rawKey) {
            return res.status(401).json({
                success: false,
                error: {
                    code: 'UNAUTHORIZED',
                    message: 'Autentikasi Gagal: Header X-API-Key atau Authorization: Bearer <key> diperlukan'
                }
            });
        }

        try {
            // Check application API key
            const appContext = await applicationService.authenticateApiKey(rawKey);

            if (!appContext) {
                // Also check if matches legacy root process.env.API_KEY
                const legacyRootKey = process.env.API_KEY || 'gopay_dev_secret_2026';
                if (safeEqual(rawKey, legacyRootKey)) {
                    req.appContext = {
                        credential_id: 'key_root_legacy',
                        application_id: 'app_default',
                        application_name: 'BionPay Default Merchant',
                        application_slug: 'default',
                        key_type: process.env.SANDBOX_MODE === 'true' ? 'SANDBOX' : 'LIVE',
                        is_sandbox: process.env.SANDBOX_MODE === 'true',
                        permissions: ['payments:read', 'payments:write', 'admin'],
                        provider_preference: 'AUTO',
                        webhook_url: null,
                        webhook_secret: process.env.API_KEY || 'whsec_legacy'
                    };
                    return next();
                }

                return res.status(401).json({
                    success: false,
                    error: {
                        code: 'INVALID_API_KEY',
                        message: 'Autentikasi Gagal: API Key tidak valid atau sudah dicabut'
                    }
                });
            }

            // Check permissions if required
            if (requiredPermission && !appContext.permissions.includes(requiredPermission) && !appContext.permissions.includes('admin')) {
                return res.status(403).json({
                    success: false,
                    error: {
                        code: 'FORBIDDEN_SCOPE',
                        message: `Akses Ditolak: API Key tidak memiliki izin scope '${requiredPermission}'`
                    }
                });
            }

            req.appContext = appContext;
            next();
        } catch (err) {
            return res.status(403).json({
                success: false,
                error: {
                    code: 'FORBIDDEN',
                    message: err.message
                }
            });
        }
    };
};

/**
 * Middleware: Admin / Dashboard Route Protection
 * Requires valid master API Key or Admin Session Token
 */
const requireAdmin = (req, res, next) => {
    let adminKey = req.headers['x-api-key'] || req.headers['x-admin-key'];

    if (!adminKey && req.headers.authorization) {
        const parts = req.headers.authorization.split(' ');
        if (parts.length === 2) adminKey = parts[1];
    }

    // Also support session header / cookie if passed
    if (!adminKey && req.query.api_key) {
        adminKey = req.query.api_key;
    }

    const masterKey = process.env.API_KEY || 'gopay_dev_secret_2026';

    if (!adminKey || !safeEqual(adminKey, masterKey)) {
        return res.status(401).json({
            success: false,
            error: {
                code: 'ADMIN_UNAUTHORIZED',
                message: 'Akses Ditolak: Otorisasi Administrator diperlukan'
            }
        });
    }

    req.adminActor = { type: 'ADMIN', id: 'master_admin' };
    next();
};

module.exports = {
    requireApiKey,
    requireAdmin,
    safeEqual
};
