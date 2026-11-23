-- 005_trust_disputes_warranty_amc_projects.sql
-- Two-Way Ratings, 48h Disputes, 30d/6m Warranties, Anti-Leakage Flags, SOS Safety, B2B AMC, Renovation & Privacy

-- Two-Way Ratings & Sub-Tags
CREATE TABLE ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    rater_user_id UUID NOT NULL REFERENCES users(id),
    ratee_user_id UUID NOT NULL REFERENCES users(id),
    direction VARCHAR(24) NOT NULL CHECK (direction IN ('CUSTOMER_TO_PROVIDER', 'PROVIDER_TO_CUSTOMER')),
    overall_stars SMALLINT NOT NULL CHECK (overall_stars BETWEEN 1 AND 5),
    sub_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], -- e.g. {'punctuality','workmanship','cleanliness','pricing_transparency'}
    comment TEXT,
    photo_blob_paths TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (booking_id, direction)
);

CREATE INDEX idx_ratings_ratee ON ratings(ratee_user_id, created_at DESC);

-- 48-Hour Disputes & Escrow Freeze
CREATE TABLE dispute_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id),
    filed_by_user_id UUID NOT NULL REFERENCES users(id),
    category VARCHAR(60) NOT NULL, -- 'INCOMPLETE_REPAIR', 'WORKMANSHIP', 'OVERCHARGING', 'NO_SHOW', 'PROPERTY_DAMAGE'
    description TEXT NOT NULL,
    evidence_blob_paths TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    status dispute_status NOT NULL DEFAULT 'OPEN_ESCROW_FROZEN',
    assigned_admin_id UUID REFERENCES users(id),
    refund_amount_npr NUMERIC(10,2) DEFAULT 0,
    resolution_notes TEXT,
    filed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- 30-Day Service & 6-Month Project Warranty Claims
CREATE TABLE warranty_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_booking_id UUID NOT NULL REFERENCES bookings(id),
    refix_booking_id UUID REFERENCES bookings(id),
    customer_id UUID NOT NULL REFERENCES users(id),
    issue_description TEXT NOT NULL,
    evidence_blob_paths TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    status warranty_status NOT NULL DEFAULT 'SUBMITTED',
    root_cause_code VARCHAR(40), -- 'WORKMANSHIP', 'FAULTY_PART', 'MISDIAGNOSIS'
    refix_hourly_payout_npr NUMERIC(10,2),
    qa_reviewer_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- Automated Anti-Leakage Anomaly Flags
CREATE TABLE anti_leakage_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id),
    booking_id UUID REFERENCES bookings(id),
    flag_type anti_leakage_flag_type NOT NULL,
    min_distance_to_customer_m NUMERIC(8,2), -- Triggers when <= 300m prior to cancel
    evidence_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
    reviewed_by UUID REFERENCES users(id),
    action_taken VARCHAR(60), -- 'DISMISSED', 'WARNING_72H', 'SUSPENDED_14D', 'PERMANENT_BAN'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
);

CREATE INDEX idx_leakage_open ON anti_leakage_flags(reviewed_at) WHERE reviewed_at IS NULL;

-- Priority-0 SOS Safety Events
CREATE TABLE sos_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id),
    triggered_by_user_id UUID NOT NULL REFERENCES users(id),
    trigger_location GEOGRAPHY(POINT, 4326),
    status sos_status NOT NULL DEFAULT 'ACTIVE_P0',
    acs_bridge_call_id VARCHAR(128),
    acknowledged_by UUID REFERENCES users(id),
    acknowledged_at TIMESTAMPTZ,
    resolution_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- B2B Annual Maintenance Contracts (AMC) — Phase 2/3
CREATE TABLE amc_contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_code VARCHAR(32) NOT NULL UNIQUE,
    client_org_name VARCHAR(180) NOT NULL,
    client_contact_user_id UUID NOT NULL REFERENCES users(id),
    account_manager_id UUID REFERENCES users(id),
    covered_pillars TEXT[] NOT NULL, -- {'PLUMBING','ELECTRICAL','COMPUTER','AC','CLEANING'}
    asset_registry JSONB NOT NULL DEFAULT '[]'::JSONB,
    annual_fee_npr NUMERIC(12,2) NOT NULL,
    emergency_sla_minutes SMALLINT NOT NULL DEFAULT 120, -- < 2 hours
    starts_on DATE NOT NULL,
    ends_on DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE amc_visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id UUID NOT NULL REFERENCES amc_contracts(id) ON DELETE CASCADE,
    booking_id UUID REFERENCES bookings(id),
    visit_type VARCHAR(24) NOT NULL CHECK (visit_type IN ('PREVENTIVE', 'EMERGENCY')),
    scheduled_for TIMESTAMPTZ NOT NULL,
    checklist_report JSONB,
    supervisor_signed_at TIMESTAMPTZ,
    client_signed_at TIMESTAMPTZ
);

-- Turnkey Renovation Projects (Sipalu Project — 6-Month Warranty)
CREATE TABLE renovation_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_code VARCHAR(32) NOT NULL UNIQUE,
    customer_id UUID NOT NULL REFERENCES users(id),
    project_manager_id UUID REFERENCES users(id),
    scope_type VARCHAR(80) NOT NULL, -- 'BATHROOM', 'KITCHEN', 'WATERPROOFING', 'FLAT_RENOVATION'
    site_survey_due_at TIMESTAMPTZ NOT NULL, -- Within 48 hours
    boq_document_blob_path TEXT,
    contract_value_npr NUMERIC(14,2),
    warranty_months SMALLINT NOT NULL DEFAULT 6,
    status VARCHAR(40) NOT NULL DEFAULT 'CONSULTATION_BOOKED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE project_milestones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES renovation_projects(id) ON DELETE CASCADE,
    sequence_no SMALLINT NOT NULL,
    title VARCHAR(140) NOT NULL,
    amount_npr NUMERIC(12,2) NOT NULL,
    escrow_status escrow_status NOT NULL DEFAULT 'PENDING_FUNDING',
    due_date DATE,
    approved_at TIMESTAMPTZ
);

-- 7-Working-Day Right-to-Erasure / PII Deletion Governance
CREATE TABLE privacy_deletion_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    request_channel VARCHAR(30) NOT NULL, -- 'IN_APP', 'EMAIL'
    status privacy_deletion_status NOT NULL DEFAULT 'REQUESTED',
    sla_due_at TIMESTAMPTZ NOT NULL, -- +7 working days
    processed_by UUID REFERENCES users(id),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
