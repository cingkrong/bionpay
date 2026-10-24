-- =================================================================
-- BIONPAY UNIFIED GATEWAY — POSTGRESQL TRANSACTIONAL SCHEMA
-- Multi-Tenant Platform Architecture with Complete Auditability
-- =================================================================

-- 1. Applications (Integrated External Websites & Clients)
CREATE TABLE IF NOT EXISTS applications (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    website_url TEXT NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    provider_preference VARCHAR(32) NOT NULL DEFAULT 'AUTO', -- 'GOPAY', 'SHOPEEPAY', 'AUTO'
    webhook_url TEXT,
    webhook_secret VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_apps_slug ON applications(slug);
CREATE INDEX IF NOT EXISTS idx_apps_active ON applications(is_active);

-- 2. API Credentials (Scoped Live & Sandbox Keys per Application)
CREATE TABLE IF NOT EXISTS api_credentials (
    id VARCHAR(64) PRIMARY KEY,
    application_id VARCHAR(64) NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key_type VARCHAR(16) NOT NULL DEFAULT 'LIVE', -- 'LIVE', 'SANDBOX'
    api_key_hash VARCHAR(255) NOT NULL, -- SHA-256 hash of API Key
    api_key_prefix VARCHAR(32) NOT NULL, -- e.g. bp_live_a1b2 or bp_test_c3d4
    permissions JSONB NOT NULL DEFAULT '["payments:read", "payments:write"]'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_creds_app ON api_credentials(application_id);
CREATE INDEX IF NOT EXISTS idx_creds_hash ON api_credentials(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_creds_prefix ON api_credentials(api_key_prefix);

-- 3. Provider Accounts (Operator's GoBiz & ShopeePay Merchant Credentials)
CREATE TABLE IF NOT EXISTS provider_accounts (
    id VARCHAR(64) PRIMARY KEY,
    provider VARCHAR(32) NOT NULL, -- 'GOPAY', 'SHOPEEPAY'
    merchant_name VARCHAR(255),
    merchant_id VARCHAR(255),
    store_name VARCHAR(255),
    qris_static_template TEXT,
    auth_token_encrypted TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'EXPIRED', 'ERROR'
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_provider_acc_provider ON provider_accounts(provider);

-- 4. Payments (Core Unified Payments with Strict Tenant Isolation)
CREATE TABLE IF NOT EXISTS payments (
    id VARCHAR(64) PRIMARY KEY,
    uuid VARCHAR(64) UNIQUE NOT NULL,
    application_id VARCHAR(64) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
    provider_account_id VARCHAR(64) REFERENCES provider_accounts(id) ON DELETE SET NULL,
    provider VARCHAR(32) NOT NULL DEFAULT 'AUTO',
    order_id VARCHAR(255) NOT NULL,
    amount BIGINT NOT NULL,
    currency VARCHAR(8) NOT NULL DEFAULT 'IDR',
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    -- Minimal Allowed Statuses: CREATED, PENDING, PAID, EXPIRED, FAILED, CANCELLED, REVIEW_REQUIRED
    customer_name VARCHAR(255),
    customer_email VARCHAR(255),
    customer_phone VARCHAR(64),
    description TEXT,
    qris_code TEXT,
    qris_image_url TEXT,
    checkout_url TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ,
    callback_url TEXT,
    return_url TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_payment_app_order UNIQUE (application_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_payments_app ON payments(application_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_amount ON payments(amount);
CREATE INDEX IF NOT EXISTS idx_payments_expires ON payments(expires_at);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);

-- 5. Payment Attempts (History of Provider Interactions for a Payment)
CREATE TABLE IF NOT EXISTS payment_attempts (
    id VARCHAR(64) PRIMARY KEY,
    payment_id VARCHAR(64) NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    attempt_number INT NOT NULL DEFAULT 1,
    provider VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL,
    provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attempts_payment ON payment_attempts(payment_id);

-- 6. Provider Transactions (Raw Settlement Feed from GoBiz & ShopeePay)
CREATE TABLE IF NOT EXISTS provider_transactions (
    id VARCHAR(64) PRIMARY KEY,
    provider VARCHAR(32) NOT NULL, -- 'GOPAY', 'SHOPEEPAY'
    provider_account_id VARCHAR(64) REFERENCES provider_accounts(id) ON DELETE SET NULL,
    provider_transaction_id VARCHAR(255) NOT NULL,
    provider_order_id VARCHAR(255),
    amount BIGINT NOT NULL,
    payer_issuer VARCHAR(255),
    payment_type VARCHAR(64),
    transaction_time TIMESTAMPTZ NOT NULL,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_claimed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_provider_tx UNIQUE (provider, provider_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_ptx_provider_txid ON provider_transactions(provider, provider_transaction_id);
CREATE INDEX IF NOT EXISTS idx_ptx_amount ON provider_transactions(amount);
CREATE INDEX IF NOT EXISTS idx_ptx_time ON provider_transactions(transaction_time);
CREATE INDEX IF NOT EXISTS idx_ptx_is_claimed ON provider_transactions(is_claimed);

-- 7. Settlement Claims (Strict Atomic 1-to-1 Mapping Between Payment and Provider Transaction)
CREATE TABLE IF NOT EXISTS settlement_claims (
    id VARCHAR(64) PRIMARY KEY,
    payment_id VARCHAR(64) NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    provider_transaction_id VARCHAR(64) NOT NULL UNIQUE REFERENCES provider_transactions(id) ON DELETE RESTRICT,
    claimed_amount BIGINT NOT NULL,
    claimed_by VARCHAR(64) NOT NULL, -- 'AUTO_WORKER', 'MANUAL_ADMIN'
    claim_status VARCHAR(32) NOT NULL DEFAULT 'VALID', -- 'VALID', 'AMBIGUOUS_REVIEW', 'REJECTED'
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_claims_payment ON settlement_claims(payment_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON settlement_claims(claim_status);

-- 8. Webhook Endpoints
CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id VARCHAR(64) PRIMARY KEY,
    application_id VARCHAR(64) NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret VARCHAR(255) NOT NULL,
    subscribed_events JSONB NOT NULL DEFAULT '["payment.success", "payment.failed", "payment.expired", "payment.review_required"]'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wh_ep_app ON webhook_endpoints(application_id);

-- 9. Webhook Events
CREATE TABLE IF NOT EXISTS webhook_events (
    id VARCHAR(64) PRIMARY KEY,
    application_id VARCHAR(64) NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    payment_id VARCHAR(64) REFERENCES payments(id) ON DELETE SET NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'DELIVERED', 'FAILED', 'DEAD_LETTER'
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wh_ev_app ON webhook_events(application_id);
CREATE INDEX IF NOT EXISTS idx_wh_ev_status ON webhook_events(status);

-- 10. Webhook Deliveries (Audit Trail & Retry Dispatcher Logs)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id VARCHAR(64) PRIMARY KEY,
    webhook_event_id VARCHAR(64) NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
    endpoint_url TEXT NOT NULL,
    attempt_number INT NOT NULL DEFAULT 1,
    request_headers JSONB NOT NULL,
    request_body TEXT NOT NULL,
    response_status INT,
    response_body TEXT,
    error_message TEXT,
    delivery_time_ms INT,
    next_retry_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wh_del_event ON webhook_deliveries(webhook_event_id);
CREATE INDEX IF NOT EXISTS idx_wh_del_next ON webhook_deliveries(next_retry_at);

-- 11. Idempotency Records (Prevents Duplicate POST /v1/payments Requests)
CREATE TABLE IF NOT EXISTS idempotency_records (
    id VARCHAR(64) PRIMARY KEY,
    application_id VARCHAR(64) NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    response_status INT NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_idempotency_app_key UNIQUE (application_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idemp_expires ON idempotency_records(expires_at);

-- 12. Audit Logs (Tamper-Resistant Security Event History)
CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    application_id VARCHAR(64) REFERENCES applications(id) ON DELETE SET NULL,
    actor_type VARCHAR(32) NOT NULL, -- 'SYSTEM', 'ADMIN', 'API_KEY'
    actor_id VARCHAR(255),
    action VARCHAR(128) NOT NULL,
    entity_type VARCHAR(64) NOT NULL,
    entity_id VARCHAR(64),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_app ON audit_logs(application_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
