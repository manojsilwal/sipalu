-- 002_identity_kyc_and_providers.sql
-- Users, Geo-Addresses, Service Businesses (Fleet), Commission Tiers, Biometric KYC & Ranking

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164 VARCHAR(20) NOT NULL UNIQUE,
    email CITEXT UNIQUE,
    full_name VARCHAR(150) NOT NULL,
    preferred_locale VARCHAR(10) NOT NULL DEFAULT 'en', -- 'en' | 'ne'
    roles user_role[] NOT NULL DEFAULT ARRAY['CUSTOMER']::user_role[],
    avatar_blob_path TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_anonymized BOOLEAN NOT NULL DEFAULT FALSE,
    entra_subject_id VARCHAR(128) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label VARCHAR(60) NOT NULL, -- 'Home', 'Office', 'Banepa House'
    city VARCHAR(80) NOT NULL,
    ward_no SMALLINT,
    tole_neighborhood VARCHAR(120) NOT NULL,
    exact_address_line TEXT NOT NULL, -- Masked during bidding; unlocked post-acceptance
    exact_location GEOGRAPHY(POINT, 4326) NOT NULL,
    masked_location GEOGRAPHY(POINT, 4326) NOT NULL, -- ~500m jittered centroid for bidding privacy
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_addresses_user ON user_addresses(user_id);
CREATE INDEX idx_user_addresses_exact_gist ON user_addresses USING GIST(exact_location);

CREATE TABLE commission_tiers (
    code VARCHAR(20) PRIMARY KEY, -- 'TRAINEE', 'VERIFIED', 'PRO', 'ELITE'
    display_name VARCHAR(40) NOT NULL,
    min_lifetime_jobs INT NOT NULL,
    max_lifetime_jobs INT, -- NULL for Elite (400+)
    min_rating_for_promotion NUMERIC(3,2) NOT NULL DEFAULT 4.40,
    commission_rate NUMERIC(5,4) NOT NULL, -- e.g. 0.2200 -> 22%
    priority_weight NUMERIC(4,2) NOT NULL DEFAULT 1.00,
    tool_loan_limit_npr NUMERIC(10,2) NOT NULL DEFAULT 0,
    public_liability_cover_npr NUMERIC(12,2) NOT NULL DEFAULT 2500000,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE service_businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id),
    business_name VARCHAR(180) NOT NULL,
    pan_vat_number VARCHAR(30) UNIQUE,
    registration_number VARCHAR(60),
    city VARCHAR(80) NOT NULL,
    settlement_bank_name VARCHAR(100),
    settlement_account_no VARCHAR(60),
    esewa_merchant_id VARCHAR(80),
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE provider_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    business_id UUID REFERENCES service_businesses(id), -- NULL for independent technicians
    tier_code VARCHAR(20) NOT NULL REFERENCES commission_tiers(code) DEFAULT 'TRAINEE',
    kyc_status kyc_status NOT NULL DEFAULT 'PENDING_SUBMISSION',
    availability_state provider_availability_state NOT NULL DEFAULT 'OFFLINE',
    primary_city VARCHAR(80) NOT NULL,
    service_radius_km NUMERIC(5,2) NOT NULL DEFAULT 8.00,
    home_base_location GEOGRAPHY(POINT, 4326),
    last_known_location GEOGRAPHY(POINT, 4326),
    last_location_at TIMESTAMPTZ,
    years_experience SMALLINT NOT NULL DEFAULT 0,
    specialties TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], -- e.g., {'plumbing','water_pump','geyser_solar'}
    -- Mandatory financial linking at registration
    linked_bank_name VARCHAR(100),
    linked_bank_account_no VARCHAR(60),
    linked_esewa_id VARCHAR(40),
    linked_khalti_id VARCHAR(40),
    financial_account_verified BOOLEAN NOT NULL DEFAULT FALSE,
    -- Ranking & Grace Mechanics
    lifetime_completed_jobs INT NOT NULL DEFAULT 0,
    rolling_avg_rating NUMERIC(3,2) NOT NULL DEFAULT 5.00,
    rolling_completion_rate NUMERIC(5,4) NOT NULL DEFAULT 1.0000,
    rolling_cancellation_rate NUMERIC(5,4) NOT NULL DEFAULT 0.0000,
    median_bid_response_sec INT NOT NULL DEFAULT 120,
    visibility_score NUMERIC(6,2) NOT NULL DEFAULT 75.00,
    new_provider_grace_until TIMESTAMPTZ, -- 14-day introductory boost before decay
    last_completed_job_at TIMESTAMPTZ,
    low_rating_consecutive_months SMALLINT NOT NULL DEFAULT 0,
    cooldown_until TIMESTAMPTZ,
    cash_jobs_enabled BOOLEAN NOT NULL DEFAULT FALSE, -- Enabled once KYC verified & float funded
    pf_ssf_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
    pan_number VARCHAR(20), -- For Form 11 tax compliance
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_provider_financial_before_active CHECK (
        kyc_status <> 'VERIFIED_ACTIVE' OR financial_account_verified = TRUE
    )
);

CREATE INDEX idx_provider_geo ON provider_profiles USING GIST(last_known_location);
CREATE INDEX idx_provider_city_state ON provider_profiles(primary_city, availability_state, kyc_status);
CREATE INDEX idx_provider_visibility ON provider_profiles(visibility_score DESC);

CREATE TABLE kyc_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
    document_type kyc_document_type NOT NULL,
    document_number VARCHAR(64) NOT NULL,
    doc_front_blob_path TEXT NOT NULL, -- Stored in private CMK-encrypted blob-kyc-vault
    doc_back_blob_path TEXT NOT NULL,
    selfie_blob_path TEXT NOT NULL,
    -- Azure AI Vision Face API & Active Liveness telemetry
    azure_liveness_session_id VARCHAR(128),
    liveness_passed BOOLEAN NOT NULL DEFAULT FALSE,
    face_match_confidence NUMERIC(5,4), -- >= 0.85 fast-track, 0.70-0.84 manual, <0.70 reject
    academy_skill_score SMALLINT, -- 0..100
    status kyc_status NOT NULL DEFAULT 'UNDER_ADMIN_REVIEW',
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    rejection_reason TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kyc_provider_status ON kyc_verifications(provider_user_id, status);

CREATE TABLE random_selfie_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
    trigger_reason VARCHAR(60) NOT NULL, -- 'PERIODIC_14D', 'DEVICE_CHANGE', 'ANTI_LEAKAGE'
    azure_liveness_session_id VARCHAR(128),
    selfie_blob_path TEXT,
    face_match_confidence NUMERIC(5,4),
    passed BOOLEAN,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE provider_ranking_snapshots (
    id BIGSERIAL PRIMARY KEY,
    provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
    visibility_score NUMERIC(6,2) NOT NULL,
    inactivity_decay_penalty NUMERIC(5,2) NOT NULL DEFAULT 0,
    tier_code VARCHAR(20) NOT NULL,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
