-- 004_ledger_escrow_float_payments.sql
-- Double-Entry Financial Ledger, Cash-Job Commission Float, Escrow Accounts, Payments & Payouts

CREATE TABLE ledger_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(64) NOT NULL UNIQUE, -- e.g. 'SYS_PLATFORM_COMMISSION', 'SYS_ESCROW_LIABILITY', 'PROV_PAYABLE:<uuid>'
    account_type ledger_account_type NOT NULL,
    owner_user_id UUID REFERENCES users(id),
    currency CHAR(3) NOT NULL DEFAULT 'NPR',
    balance_npr NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(120) NOT NULL UNIQUE,
    booking_id UUID REFERENCES bookings(id),
    reference_type VARCHAR(50) NOT NULL, -- 'JOB_SETTLEMENT', 'ESCROW_HOLD', 'ESCROW_RELEASE', 'FLOAT_TOPUP', 'PAYOUT', 'REFUND'
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ledger_entries (
    id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
    debit_npr NUMERIC(14,2) NOT NULL DEFAULT 0.00 CHECK (debit_npr >= 0),
    credit_npr NUMERIC(14,2) NOT NULL DEFAULT 0.00 CHECK (credit_npr >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_single_sided_entry CHECK (
        (debit_npr > 0 AND credit_npr = 0) OR (credit_npr > 0 AND debit_npr = 0)
    )
);

CREATE INDEX idx_ledger_entries_tx ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_entries_account ON ledger_entries(account_id, created_at DESC);

-- Cash-Job Prepaid Commission Float Wallet
CREATE TABLE provider_float_wallets (
    provider_user_id UUID PRIMARY KEY REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
    ledger_account_id UUID NOT NULL UNIQUE REFERENCES ledger_accounts(id),
    current_float_npr NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    recommended_min_npr NUMERIC(10,2) NOT NULL DEFAULT 500.00,
    auto_pause_threshold_npr NUMERIC(10,2) NOT NULL DEFAULT -300.00,
    is_cash_paused BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Escrow & Milestone Protection
CREATE TABLE escrow_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id),
    total_held_npr NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    released_npr NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    refunded_npr NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    status escrow_status NOT NULL DEFAULT 'PENDING_FUNDING',
    auto_release_at TIMESTAMPTZ, -- 48h post-completion if no dispute filed
    frozen_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Multi-Rail Payment Transactions (eSewa, Khalti, Fonepay, ConnectIPS, Cash)
CREATE TABLE payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID REFERENCES bookings(id),
    payer_user_id UUID NOT NULL REFERENCES users(id),
    payment_method payment_method NOT NULL,
    amount_npr NUMERIC(12,2) NOT NULL CHECK (amount_npr > 0),
    status payment_status NOT NULL DEFAULT 'INITIATED',
    idempotency_key VARCHAR(120) NOT NULL UNIQUE,
    gateway_ref_id VARCHAR(128) UNIQUE,
    gateway_signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
    gateway_raw_payload JSONB,
    reconciled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_booking ON payment_transactions(booking_id);
CREATE INDEX idx_payments_recon ON payment_transactions(status, reconciled_at) WHERE reconciled_at IS NULL;

-- Multi-Cadence Provider Payouts (Instant 2h, Same-Day 11AM/5PM, Monday Bank)
CREATE TABLE payout_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id),
    cadence payout_cadence NOT NULL,
    gross_amount_npr NUMERIC(12,2) NOT NULL CHECK (gross_amount_npr >= 100.00),
    instant_fee_npr NUMERIC(8,2) NOT NULL DEFAULT 0.00, -- NPR 25 for INSTANT_2H, 0 for batch/weekly
    net_disbursed_npr NUMERIC(12,2) NOT NULL,
    destination_rail VARCHAR(40) NOT NULL, -- 'ESEWA', 'KHALTI', 'IME_PAY', 'CONNECT_IPS', 'BANK'
    destination_account VARCHAR(80) NOT NULL,
    status payout_status NOT NULL DEFAULT 'QUEUED',
    idempotency_key VARCHAR(120) NOT NULL UNIQUE,
    external_payout_ref VARCHAR(128),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ
);

CREATE INDEX idx_payouts_provider_status ON payout_requests(provider_user_id, status);

-- Promos & Loyalty Points
CREATE TABLE promo_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(40) NOT NULL UNIQUE,
    discount_type VARCHAR(16) NOT NULL CHECK (discount_type IN ('PERCENT', 'FLAT_NPR')),
    discount_value NUMERIC(10,2) NOT NULL,
    max_discount_npr NUMERIC(10,2),
    min_order_npr NUMERIC(10,2) NOT NULL DEFAULT 0,
    usage_limit_total INT,
    usage_limit_per_user SMALLINT NOT NULL DEFAULT 1,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE loyalty_point_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    booking_id UUID REFERENCES bookings(id),
    points_delta INT NOT NULL, -- Positive for earn, negative for redeem
    reason VARCHAR(80) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_loyalty_user ON loyalty_point_ledger(user_id, created_at DESC);
