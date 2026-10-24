'use strict';

const crypto = require('crypto');
const db = require('../database/db');
const webhookService = require('./webhookService');

class ReconciliationService {
    /**
     * Ingest a settlement transaction from provider (GoBiz or ShopeePay)
     * Enforces unique constraint: cannot ingest duplicates.
     */
    async ingestProviderTransaction(data) {
        const { provider, provider_transaction_id, provider_order_id, amount, payer_issuer, payment_type, transaction_time, raw_payload } = data;

        const id = 'ptx_' + crypto.randomBytes(12).toString('hex');
        const numAmount = parseInt(amount, 10);
        const txTime = new Date(transaction_time || Date.now()).toISOString();

        try {
            const res = await db.query(`
                INSERT INTO provider_transactions (id, provider, provider_transaction_id, provider_order_id, amount, payer_issuer, payment_type, transaction_time, raw_payload, is_claimed, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10)
                ON CONFLICT (provider, provider_transaction_id) DO NOTHING
                RETURNING *
            `, [id, provider.toUpperCase(), provider_transaction_id, provider_order_id || null, numAmount, payer_issuer || 'Bank / QRIS', payment_type || 'QRIS', txTime, JSON.stringify(raw_payload || {}), new Date().toISOString()]);

            return res.rows && res.rows[0] ? res.rows[0] : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Atomically Match and Claim Settlement Transactions against Pending Payments
     */
    async matchPendingPayments() {
        const now = new Date();
        const nowIso = now.toISOString();

        // 1. Mark expired payments that passed expires_at
        await db.query(`
            UPDATE payments
            SET status = 'EXPIRED', updated_at = $1
            WHERE status = 'PENDING' AND expires_at < $1
        `, [nowIso]);

        // 2. Fetch all active PENDING payments
        const pendingPaymentsRes = await db.query(`
            SELECT * FROM payments
            WHERE status = 'PENDING' AND expires_at >= $1
            ORDER BY created_at ASC
        `, [nowIso]);

        const pendingPayments = pendingPaymentsRes.rows || [];
        if (pendingPayments.length === 0) return { matched: 0, ambiguous: 0 };

        // 3. Fetch all unclaimed provider transactions
        const unclaimedRes = await db.query(`
            SELECT * FROM provider_transactions
            WHERE is_claimed = false
            ORDER BY transaction_time DESC
        `);

        const unclaimedTxs = unclaimedRes.rows || [];
        if (unclaimedTxs.length === 0) return { matched: 0, ambiguous: 0 };

        let matchedCount = 0;
        let ambiguousCount = 0;

        for (const payment of pendingPayments) {
            // Find all unclaimed transactions matching the EXACT amount and provider
            const candidates = unclaimedTxs.filter(tx => {
                if (tx.is_claimed) return false;
                if (parseInt(tx.amount, 10) !== parseInt(payment.amount, 10)) return false;

                // Provider check
                const pProvider = (payment.provider || 'AUTO').toUpperCase();
                if (pProvider !== 'AUTO' && tx.provider.toUpperCase() !== pProvider) return false;

                // Time window check: tx time must be >= payment created_at (minus 2 min tolerance)
                const pCreated = new Date(payment.created_at).getTime() - 120000;
                const txTime = new Date(tx.transaction_time).getTime();
                return txTime >= pCreated;
            });

            if (candidates.length === 0) {
                continue;
            }

            // Check if there are OTHER pending payments competing for this exact same amount and provider
            const competingPayments = pendingPayments.filter(p => 
                p.id !== payment.id && 
                parseInt(p.amount, 10) === parseInt(payment.amount, 10) &&
                (p.provider === 'AUTO' || payment.provider === 'AUTO' || p.provider === payment.provider)
            );

            if (competingPayments.length > 0 && candidates.length <= competingPayments.length) {
                // AMBIGUOUS COLLISION!
                // Multiple pending payments with identical amounts compete for a single transaction without a unique order ID reference.
                // Mark payment as REVIEW_REQUIRED, DO NOT send payment.success!
                await this.flagAmbiguousReview(payment.id, candidates[0].id, 'Terdapat beberapa sesi pembayaran dengan nominal identik pada jendela waktu yang sama');
                ambiguousCount++;
                continue;
            }

            // Select the best candidate (exact order reference match first, else oldest valid candidate)
            let chosenTx = candidates.find(c => c.provider_order_id && c.provider_order_id === payment.order_id);
            if (!chosenTx) {
                chosenTx = candidates[0];
            }

            // Atomically claim the transaction
            const success = await this.claimTransactionAtomically(payment.id, chosenTx.id, parseInt(payment.amount, 10), 'AUTO_WORKER');
            if (success) {
                chosenTx.is_claimed = true;
                matchedCount++;
            }
        }

        return { matched: matchedCount, ambiguous: ambiguousCount };
    }

    /**
     * Atomically claim a transaction for a payment inside an explicit database transaction
     */
    async claimTransactionAtomically(paymentId, providerTxId, amount, claimedBy = 'AUTO_WORKER', notes = '') {
        return db.transaction(async (client) => {
            // 1. Lock and check provider transaction
            const txRes = await client.query(`
                SELECT * FROM provider_transactions
                WHERE id = $1 AND is_claimed = false
            `, [providerTxId]);

            if (!txRes.rows || txRes.rows.length === 0) {
                return false; // Already claimed or not found
            }
            const providerTx = txRes.rows[0];

            // 2. Lock and check payment
            const payRes = await client.query(`
                SELECT * FROM payments
                WHERE id = $1 AND status IN ('PENDING', 'REVIEW_REQUIRED')
            `, [paymentId]);

            if (!payRes.rows || payRes.rows.length === 0) {
                return false;
            }
            const payment = payRes.rows[0];

            // Verify exact amount
            if (parseInt(providerTx.amount, 10) !== parseInt(payment.amount, 10)) {
                throw new Error(`Klaim Ditolak: Nominal transaksi provider (Rp ${providerTx.amount}) tidak sesuai dengan tagihan pembayaran (Rp ${payment.amount})`);
            }

            const claimId = 'clm_' + crypto.randomBytes(12).toString('hex');
            const now = new Date().toISOString();

            // 3. Mark provider transaction as claimed
            await client.query(`UPDATE provider_transactions SET is_claimed = true WHERE id = $1`, [providerTxId]);

            // 4. Insert settlement claim
            await client.query(`
                INSERT INTO settlement_claims (id, payment_id, provider_transaction_id, claimed_amount, claimed_by, claim_status, claimed_at, notes)
                VALUES ($1, $2, $3, $4, $5, 'VALID', $6, $7)
            `, [claimId, paymentId, providerTxId, amount, claimedBy, now, notes]);

            // 5. Update payment to PAID
            await client.query(`
                UPDATE payments
                SET status = 'PAID', paid_at = $1, provider = $2, updated_at = $1
                WHERE id = $3
            `, [now, providerTx.provider, paymentId]);

            // 6. Enqueue & dispatch signed webhook (payment.success)
            const webhookPayload = {
                event: 'payment.success',
                payment_id: payment.id,
                uuid: payment.uuid,
                order_id: payment.order_id,
                amount: parseInt(payment.amount, 10),
                currency: payment.currency,
                status: 'PAID',
                provider: providerTx.provider,
                payer_issuer: providerTx.payer_issuer,
                payment_type: providerTx.payment_type,
                paid_at: now,
                metadata: payment.metadata
            };

            // Dispatch outside transaction or asynchronously
            setTimeout(() => {
                webhookService.dispatchEvent(payment.application_id, payment.id, 'payment.success', webhookPayload).catch(() => {});
            }, 50);

            return true;
        });
    }

    /**
     * Flag an ambiguous match for manual admin review
     */
    async flagAmbiguousReview(paymentId, providerTxId, reason) {
        const now = new Date().toISOString();
        await db.query(`
            UPDATE payments
            SET status = 'REVIEW_REQUIRED', review_notes = $1, updated_at = $2
            WHERE id = $3
        `, [reason, now, paymentId]);

        const claimId = 'clm_rev_' + crypto.randomBytes(10).toString('hex');
        await db.query(`
            INSERT INTO settlement_claims (id, payment_id, provider_transaction_id, claimed_amount, claimed_by, claim_status, claimed_at, notes)
            VALUES ($1, $2, $3, 0, 'SYSTEM_AMBIGUOUS', 'AMBIGUOUS_REVIEW', $4, $5)
            ON CONFLICT (provider_transaction_id) DO NOTHING
        `, [claimId, paymentId, providerTxId, now, reason]);

        // Dispatch review required webhook
        const payRes = await db.query(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
        if (payRes.rows && payRes.rows[0]) {
            const p = payRes.rows[0];
            const payload = {
                event: 'payment.review_required',
                payment_id: p.id,
                order_id: p.order_id,
                amount: parseInt(p.amount, 10),
                status: 'REVIEW_REQUIRED',
                reason: reason
            };
            webhookService.dispatchEvent(p.application_id, p.id, 'payment.review_required', payload).catch(() => {});
        }
    }

    /**
     * Get Unmatched / Ambiguous Settlements for Admin Review
     */
    async getUnmatchedSettlements(limit = 50) {
        const res = await db.query(`
            SELECT pt.*, 
                (SELECT COUNT(*) FROM payments p WHERE p.status = 'PENDING' AND p.amount = pt.amount) as competing_pending_count
            FROM provider_transactions pt
            WHERE pt.is_claimed = false
            ORDER BY pt.transaction_time DESC
            LIMIT $1
        `, [limit]);

        return res.rows || [];
    }

    /**
     * Admin Manual Claim Review
     */
    async manualAdminClaim(paymentId, providerTxId, adminId = 'admin', notes = '', ip = '127.0.0.1') {
        const payRes = await db.query(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
        if (!payRes.rows || payRes.rows.length === 0) throw new Error('Pembayaran tidak ditemukan');
        const payment = payRes.rows[0];

        const success = await this.claimTransactionAtomically(paymentId, providerTxId, parseInt(payment.amount, 10), 'MANUAL_ADMIN', notes);
        if (!success) {
            throw new Error('Gagal mengklaim mutasi: transaksi mungkin sudah diklaim oleh pembayaran lain');
        }

        // Record audit log
        const audId = 'aud_' + crypto.randomBytes(12).toString('hex');
        await db.query(`
            INSERT INTO audit_logs (id, application_id, actor_type, actor_id, action, entity_type, entity_id, details, ip_address, created_at)
            VALUES ($1, $2, 'ADMIN', $3, 'SETTLEMENT_MANUAL_CLAIM', 'payment', $4, $5, $6, $7)
        `, [audId, payment.application_id, adminId, paymentId, JSON.stringify({ provider_transaction_id: providerTxId, notes }), ip, new Date().toISOString()]);

        return { success: true, message: 'Mutasi berhasil diverifikasi dan dikaitkan secara manual' };
    }
}

const reconciliationService = new ReconciliationService();

// Run background settlement reconciliation matcher every 8 seconds
setInterval(() => {
    reconciliationService.matchPendingPayments().catch(() => {});
}, 8000);

module.exports = reconciliationService;
