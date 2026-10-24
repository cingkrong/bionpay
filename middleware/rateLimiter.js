'use strict';

/**
 * In-memory sliding window rate limiter
 */
const rateLimitBuckets = new Map();

function rateLimiter(options = {}) {
    const windowMs = options.windowMs || 60 * 1000; // 1 minute default
    const maxRequests = options.max || 120; // 120 requests per minute
    const message = options.message || 'Terlalu banyak permintaan, silakan coba lagi beberapa saat lagi';

    // Periodically clean stale buckets every 5 minutes
    setInterval(() => {
        const now = Date.now();
        for (const [key, record] of rateLimitBuckets.entries()) {
            if (now - record.resetTime > windowMs) {
                rateLimitBuckets.delete(key);
            }
        }
    }, 5 * 60 * 1000);

    return (req, res, next) => {
        // IP identifier
        const ip = req.ip || req.connection?.remoteAddress || '127.0.0.1';
        const key = `${ip}:${options.prefix || 'global'}`;
        const now = Date.now();

        let record = rateLimitBuckets.get(key);
        if (!record || now > record.resetTime) {
            record = {
                count: 1,
                resetTime: now + windowMs
            };
            rateLimitBuckets.set(key, record);
        } else {
            record.count++;
        }

        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - record.count));
        res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetTime / 1000));

        if (record.count > maxRequests) {
            return res.status(429).json({
                success: false,
                error: {
                    code: 'RATE_LIMIT_EXCEEDED',
                    message,
                    retry_after_seconds: Math.ceil((record.resetTime - now) / 1000)
                }
            });
        }

        next();
    };
}

module.exports = {
    rateLimiter
};
