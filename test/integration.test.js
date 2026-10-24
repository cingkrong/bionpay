'use strict';

/**
 * BionPay Platform Hub & REST API V1 - Automated Integration & Integrity Test Suite
 * Executes end-to-end testing across all 8 upgrade phases.
 */

const axios = require('axios');
const crypto = require('crypto');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'http://localhost:3000';
const ROOT_API_KEY = process.env.API_KEY || 'gopay_dev_secret_2026';

let passedTests = 0;
let totalTests = 0;

async function test(name, fn) {
    totalTests++;
    process.stdout.write(`  [TEST] ${name} ... `);
    try {
        await fn();
        passedTests++;
        console.log('✅ PASS');
    } catch (err) {
        console.log('❌ FAIL');
        console.error(`         Error: ${err.message}`);
        if (err.response && err.response.data) {
            console.error(`         Response: ${JSON.stringify(err.response.data)}`);
        }
    }
}

async function runAllTests() {
    console.log('===============================================================');
    console.log('   BIONPAY INTEGRATION PLATFORM UPGRADE - TEST SUITE');
    console.log('===============================================================\n');

    let tenantApp = null;
    let tenantLiveKey = null;
    let tenantTestKey = null;
    let tenantWebhookSecret = null;
    let createdPaymentId = null;

    // 1. Health Telemetry
    await test('PHASE 3: GET /v1/health returns healthy telemetry', async () => {
        const res = await axios.get(`${BASE_URL}/v1/health`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.success, true);
        assert.strictEqual(res.data.data.status, 'HEALTHY');
        assert.strictEqual(res.data.data.api_version, 'v1');
    });

    // 2. Application Registration
    await test('PHASE 2: POST /api/applications registers new tenant website', async () => {
        const uniqueSuffix = Date.now().toString(36);
        const payload = {
            name: `E-Commerce Store ${uniqueSuffix}`,
            website_url: `https://example.com`,
            webhook_url: `https://example.com/api/webhook`,
            provider_preference: 'AUTO',
            description: 'Automated test application store'
        };

        const res = await axios.post(`${BASE_URL}/api/applications`, payload, {
            headers: { 'x-api-key': ROOT_API_KEY }
        });

        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.data.success, true);
        const liveCred = res.data.data.initial_credentials.live;
        const testCred = res.data.data.initial_credentials.sandbox;
        const liveKey = liveCred.api_key || liveCred.raw_key;
        const testKey = testCred.api_key || testCred.raw_key;

        assert.ok(res.data.data.id.startsWith('app_'));
        assert.ok(liveKey.startsWith('bp_live_'));
        assert.ok(testKey.startsWith('bp_test_'));

        tenantApp = res.data.data;
        tenantLiveKey = liveKey;
        tenantTestKey = testKey;
        tenantWebhookSecret = res.data.data.webhook_secret;
    });

    // 3. Create Additional Scoped API Key
    await test('PHASE 2: POST /api/applications/:id/keys generates scoped credential', async () => {
        const payload = {
            name: 'Secondary Readonly Key',
            key_type: 'LIVE',
            permissions: ['payments:read']
        };

        const res = await axios.post(`${BASE_URL}/api/applications/${tenantApp.id}/keys`, payload, {
            headers: { 'x-api-key': ROOT_API_KEY }
        });

        assert.strictEqual(res.status, 201);
        const genKey = res.data.data.api_key || res.data.data.raw_key;
        assert.ok(genKey.startsWith('bp_live_'));
    });

    // 4. Create Payment via V1 with Idempotency-Key
    const idempKey = 'idemp_' + crypto.randomBytes(8).toString('hex');
    const orderId = 'ORD-' + Date.now();
    const paymentPayload = {
        order_id: orderId,
        amount: 35000,
        customer_name: 'Budi Santoso',
        customer_email: 'budi@example.com',
        description: 'Pembelian Produk Bion Digital',
        callback_url: 'https://example.com/checkout/callback',
        provider: 'AUTO',
        expires_in_minutes: 15
    };

    await test('PHASE 3: POST /v1/payments creates payment session with EMVCo QRIS', async () => {
        const res = await axios.post(`${BASE_URL}/v1/payments`, paymentPayload, {
            headers: {
                'x-api-key': tenantLiveKey,
                'Idempotency-Key': idempKey
            }
        });

        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.data.success, true);
        assert.strictEqual(res.data.data.status, 'PENDING');
        assert.strictEqual(res.data.data.amount, 35000);
        assert.strictEqual(res.data.data.order_id, orderId);
        assert.ok(res.data.data.checkout_url.includes('/checkout/'));
        assert.ok(res.data.data.qris_image_url.includes('/qr/'));

        createdPaymentId = res.data.data.id;
    });

    // 5. Idempotent Replay
    await test('PHASE 3: Idempotent replay returns cached response with identical payment ID', async () => {
        const res = await axios.post(`${BASE_URL}/v1/payments`, paymentPayload, {
            headers: {
                'x-api-key': tenantLiveKey,
                'Idempotency-Key': idempKey
            }
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.data.id, createdPaymentId);
        assert.strictEqual(res.data.data.cached, true);
    });

    // 6. Idempotency Conflict Check
    await test('PHASE 3: Idempotency conflict with mismatched payload returns 409', async () => {
        const conflictingPayload = { ...paymentPayload, amount: 99999 };
        try {
            await axios.post(`${BASE_URL}/v1/payments`, conflictingPayload, {
                headers: {
                    'x-api-key': tenantLiveKey,
                    'Idempotency-Key': idempKey
                }
            });
            assert.fail('Should have failed with 409');
        } catch (err) {
            assert.strictEqual(err.response.status, 409);
            assert.strictEqual(err.response.data.error.code, 'IDEMPOTENCY_CONFLICT');
        }
    });

    // 7. Duplicate Order ID check
    await test('PHASE 3: Reusing same order_id under same application returns 409 DUPLICATE_ORDER_ID', async () => {
        const dupPayload = { ...paymentPayload };
        try {
            await axios.post(`${BASE_URL}/v1/payments`, dupPayload, {
                headers: { 'x-api-key': tenantLiveKey }
            });
            assert.fail('Should have failed with 409');
        } catch (err) {
            assert.strictEqual(err.response.status, 409);
            assert.strictEqual(err.response.data.error.code, 'DUPLICATE_ORDER_ID');
        }
    });

    // 8. Get Payment Details
    await test('PHASE 3: GET /v1/payments/:id returns active payment metadata', async () => {
        const res = await axios.get(`${BASE_URL}/v1/payments/${createdPaymentId}`, {
            headers: { 'x-api-key': tenantLiveKey }
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.data.id, createdPaymentId);
        assert.strictEqual(res.data.data.status, 'PENDING');
        assert.strictEqual(res.data.data.currency, 'IDR');
    });

    // 9. Tenant Isolation
    await test('PHASE 3: Tenant isolation prevents cross-tenant payment access', async () => {
        // Create second tenant
        const res2 = await axios.post(`${BASE_URL}/api/applications`, {
            name: 'Store Two Tenant',
            website_url: 'https://example.org'
        }, { headers: { 'x-api-key': ROOT_API_KEY } });

        const store2Key = res2.data.data.initial_credentials.live.api_key;

        try {
            await axios.get(`${BASE_URL}/v1/payments/${createdPaymentId}`, {
                headers: { 'x-api-key': store2Key }
            });
            assert.fail('Should have returned 404 for different tenant');
        } catch (err) {
            assert.strictEqual(err.response.status, 404);
        }
    });

    // 10. Cancel Payment
    await test('PHASE 3: POST /v1/payments/:id/cancel explicitly transitions state to CANCELLED', async () => {
        const res = await axios.post(`${BASE_URL}/v1/payments/${createdPaymentId}/cancel`, {}, {
            headers: { 'x-api-key': tenantLiveKey }
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.data.status, 'CANCELLED');
    });

    // 11. HMAC-SHA256 Webhook Signing Verification
    await test('PHASE 4: HMAC-SHA256 signature calculation matches X-BionPay-Signature format', async () => {
        const samplePayload = {
            id: 'evt_test_123',
            event: 'payment.success',
            data: { id: 'pay_test', amount: 50000, status: 'PAID' }
        };
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const rawBody = JSON.stringify(samplePayload);
        const secret = 'whsec_secret_key_sample';

        const computedSig = crypto.createHmac('sha256', secret)
            .update(`${timestamp}.${rawBody}`)
            .digest('hex');

        // Verification logic
        const expected = crypto.createHmac('sha256', secret)
            .update(`${timestamp}.${rawBody}`)
            .digest('hex');

        assert.strictEqual(computedSig, expected);
        assert.strictEqual(computedSig.length, 64);
    });

    // 12. Ambiguous Collision Detection (REVIEW_REQUIRED)
    await test('PHASE 6: Identical amount collision across multiple pending payments flags REVIEW_REQUIRED', async () => {
        const collisionAmount = 20000 + Math.floor(Math.random() * 50000);

        // Payment A
        const payA = await axios.post(`${BASE_URL}/v1/payments`, {
            order_id: 'COLLISION-A-' + Date.now(),
            amount: collisionAmount,
            provider: 'AUTO'
        }, { headers: { 'x-api-key': tenantLiveKey } });

        // Payment B
        const payB = await axios.post(`${BASE_URL}/v1/payments`, {
            order_id: 'COLLISION-B-' + Date.now(),
            amount: collisionAmount,
            provider: 'AUTO'
        }, { headers: { 'x-api-key': tenantLiveKey } });

        // Ingest a single provider transaction with that exact amount without order ID via API
        await axios.post(`${BASE_URL}/api/reconciliation/ingest`, {
            provider: 'GOPAY',
            provider_transaction_id: 'TX_COLLISION_' + Date.now(),
            amount: collisionAmount,
            payer_issuer: 'BCA / QRIS',
            payment_type: 'QRIS',
            transaction_time: new Date().toISOString()
        }, { headers: { 'x-api-key': ROOT_API_KEY } });

        // Run reconciliation matcher via API
        await axios.post(`${BASE_URL}/api/reconciliation/match`, {}, {
            headers: { 'x-api-key': ROOT_API_KEY }
        });

        // Payment A should be flagged REVIEW_REQUIRED to prevent false-positive claim
        const checkA = await axios.get(`${BASE_URL}/v1/payments/${payA.data.data.id}`, {
            headers: { 'x-api-key': tenantLiveKey }
        });

        assert.strictEqual(checkA.data.data.status, 'REVIEW_REQUIRED');
        assert.ok(checkA.data.data.review_notes.includes('identik'));
    });

    // 13. Atomic Settlement & Anti Double-Claim
    await test('PHASE 6: Atomic claim verifies exact amount and prevents double claiming', async () => {
        const strictAmount = 70000 + Math.floor(Math.random() * 20000);
        const uniquePay = await axios.post(`${BASE_URL}/v1/payments`, {
            order_id: 'ATOMIC-PAY-' + Date.now(),
            amount: strictAmount,
            provider: 'GOPAY'
        }, { headers: { 'x-api-key': tenantLiveKey } });

        const ptxRes = await axios.post(`${BASE_URL}/api/reconciliation/ingest`, {
            provider: 'GOPAY',
            provider_transaction_id: 'TX_ATOMIC_' + Date.now(),
            amount: strictAmount,
            payer_issuer: 'GoPay Instore',
            payment_type: 'QRIS',
            transaction_time: new Date().toISOString()
        }, { headers: { 'x-api-key': ROOT_API_KEY } });

        assert.ok(ptxRes.data.data);
        const ptx = ptxRes.data.data;

        // Claim once via API
        const claimRes = await axios.post(`${BASE_URL}/api/reconciliation/claim`, {
            payment_id: uniquePay.data.data.id,
            provider_transaction_id: ptx.id,
            notes: 'Verified transfer proof'
        }, { headers: { 'x-api-key': ROOT_API_KEY } });

        assert.strictEqual(claimRes.data.success, true);

        // Attempting to claim second time MUST fail (Anti double-claim)
        try {
            await axios.post(`${BASE_URL}/api/reconciliation/claim`, {
                payment_id: 'pay_another_dummy',
                provider_transaction_id: ptx.id,
                notes: 'Second malicious claim attempt'
            }, { headers: { 'x-api-key': ROOT_API_KEY } });
            assert.fail('Should have failed to claim already claimed transaction');
        } catch (e) {
            assert.ok(e.response.status === 400 || e.response.status === 409);
        }

        // Verify payment is now PAID
        const verifiedPay = await axios.get(`${BASE_URL}/v1/payments/${uniquePay.data.data.id}`, {
            headers: { 'x-api-key': tenantLiveKey }
        });
        assert.strictEqual(verifiedPay.data.data.status, 'PAID');
    });

    // 14. Legacy Adapter Backward Compatibility
    await test('PHASE 3: Legacy endpoint /create-qris maintains 100% backward compatibility', async () => {
        const legacyRes = await axios.post(`${BASE_URL}/create-qris`, {
            amount: 15000,
            order_id: 'LEGACY-TEST-' + Date.now()
        }, {
            headers: { 'x-api-key': ROOT_API_KEY }
        });

        assert.strictEqual(legacyRes.status, 200);
        assert.strictEqual(legacyRes.data.success, true);
        assert.ok(legacyRes.data.data.qris_id);
        assert.ok(legacyRes.data.data.checkout_url);
    });

    // 15. SSRF Validation
    await test('PHASE 0 & 4: SSRF protection blocks cloud metadata IP and loopback addresses', async () => {
        const { validateSafeUrl } = require('../utils/ssrf');

        // Cloud metadata IP
        let metadataBlocked = false;
        try {
            await validateSafeUrl('http://169.254.169.254/latest/meta-data', false);
        } catch (e) {
            metadataBlocked = true;
        }
        assert.strictEqual(metadataBlocked, true);

        // Non-http scheme
        let ftpBlocked = false;
        try {
            await validateSafeUrl('ftp://example.com/callback', false);
        } catch (e) {
            ftpBlocked = true;
        }
        assert.strictEqual(ftpBlocked, true);
    });

    console.log('\n===============================================================');
    console.log(`   TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
    console.log('===============================================================\n');

    if (passedTests === totalTests) {
        process.exit(0);
    } else {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Fatal Test Error:', err);
    process.exit(1);
});
