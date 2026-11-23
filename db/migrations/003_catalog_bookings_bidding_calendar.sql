-- 003_catalog_bookings_bidding_calendar.sql
-- Geo Service Zones, 10-Vertical Catalog, Hybrid Bookings, Live Bidding, Change Orders & GiST Calendar Locks

CREATE TABLE service_zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(32) NOT NULL UNIQUE, -- 'BANEPA', 'KATHMANDU', 'LALITPUR', 'BHAKTAPUR', 'POKHARA'
    name_en VARCHAR(100) NOT NULL,
    name_ne VARCHAR(100) NOT NULL,
    boundary GEOGRAPHY(POLYGON, 4326),
    is_pilot_active BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(80) NOT NULL UNIQUE,
    name_en VARCHAR(120) NOT NULL,
    name_ne VARCHAR(120) NOT NULL,
    icon_url TEXT,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE subcategories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    slug VARCHAR(100) NOT NULL UNIQUE,
    name_en VARCHAR(140) NOT NULL,
    name_ne VARCHAR(140) NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE service_skus (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subcategory_id UUID NOT NULL REFERENCES subcategories(id) ON DELETE CASCADE,
    slug VARCHAR(140) NOT NULL UNIQUE,
    title_en VARCHAR(200) NOT NULL,
    title_ne VARCHAR(200) NOT NULL,
    description_en TEXT,
    description_ne TEXT,
    pricing_mode pricing_mode NOT NULL DEFAULT 'HYBRID',
    base_labor_npr NUMERIC(10,2) NOT NULL DEFAULT 0,
    unit_label VARCHAR(40) NOT NULL DEFAULT 'Unit', -- 'Unit', 'Inspection', '10m', 'Session'
    estimated_duration_min SMALLINT NOT NULL DEFAULT 60,
    warranty_days SMALLINT NOT NULL DEFAULT 30,
    min_bid_sanity_npr NUMERIC(10,2),
    max_bid_sanity_npr NUMERIC(10,2),
    inclusions JSONB NOT NULL DEFAULT '[]'::JSONB,
    exclusions JSONB NOT NULL DEFAULT '[]'::JSONB,
    symptom_keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE city_sku_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku_id UUID NOT NULL REFERENCES service_skus(id) ON DELETE CASCADE,
    zone_id UUID NOT NULL REFERENCES service_zones(id) ON DELETE CASCADE,
    labor_price_npr NUMERIC(10,2) NOT NULL,
    visiting_fee_npr NUMERIC(10,2) NOT NULL DEFAULT 100.00, -- Protected travel fee to expert
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (sku_id, zone_id)
);

CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_code VARCHAR(24) NOT NULL UNIQUE, -- e.g. 'SPL-261123-00421'
    customer_id UUID NOT NULL REFERENCES users(id),
    assigned_provider_id UUID REFERENCES provider_profiles(user_id),
    preferred_provider_id UUID REFERENCES provider_profiles(user_id),
    zone_id UUID NOT NULL REFERENCES service_zones(id),
    category_id UUID NOT NULL REFERENCES categories(id),
    sku_id UUID REFERENCES service_skus(id), -- NULL allowed for open Live Bidding requests
    booking_mode booking_mode NOT NULL,
    urgency urgency_level NOT NULL DEFAULT 'SCHEDULED',
    status booking_status NOT NULL DEFAULT 'CREATED',
    -- Location & Privacy
    address_id UUID NOT NULL REFERENCES user_addresses(id),
    exact_address_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
    -- Issue Context
    issue_description TEXT,
    media_blob_paths TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    quantity SMALLINT NOT NULL DEFAULT 1 CHECK (quantity >= 1),
    -- Schedule & Bidding Windows
    requested_slot_start TIMESTAMPTZ NOT NULL,
    requested_slot_end TIMESTAMPTZ NOT NULL,
    bidding_closes_at TIMESTAMPTZ,
    estimated_duration_min SMALLINT NOT NULL DEFAULT 60,
    -- Pricing Summary (NPR)
    quoted_labor_npr NUMERIC(10,2) NOT NULL DEFAULT 0,
    approved_change_order_labor_npr NUMERIC(10,2) NOT NULL DEFAULT 0,
    approved_parts_mrp_npr NUMERIC(10,2) NOT NULL DEFAULT 0,
    visiting_fee_npr NUMERIC(10,2) NOT NULL DEFAULT 100.00,
    discount_npr NUMERIC(10,2) NOT NULL DEFAULT 0,
    loyalty_redeemed_npr NUMERIC(10,2) NOT NULL DEFAULT 0,
    tip_npr NUMERIC(10,2) NOT NULL DEFAULT 0,
    vat_npr NUMERIC(10,2) NOT NULL DEFAULT 0,
    final_total_npr NUMERIC(10,2) NOT NULL DEFAULT 0,
    -- Execution Proof & Warranty
    payment_method payment_method,
    completion_otp_hash VARCHAR(128),
    before_photo_paths TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    after_photo_paths TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    warranty_days SMALLINT NOT NULL DEFAULT 30,
    warranty_expires_at TIMESTAMPTZ,
    parent_booking_id UUID REFERENCES bookings(id), -- For warranty re-fixes
    -- Lifecycle Timestamps
    accepted_at TIMESTAMPTZ,
    en_route_at TIMESTAMPTZ,
    arrived_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancelled_by UUID REFERENCES users(id),
    cancellation_reason TEXT,
    client_idempotency_key VARCHAR(100) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bookings_customer ON bookings(customer_id, created_at DESC);
CREATE INDEX idx_bookings_provider ON bookings(assigned_provider_id, status);
CREATE INDEX idx_bookings_zone_status ON bookings(zone_id, status, bidding_closes_at);

-- Live Competitive Bids
CREATE TABLE bids (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id),
    quoted_labor_npr NUMERIC(10,2) NOT NULL CHECK (quoted_labor_npr > 0),
    estimated_arrival_min SMALLINT NOT NULL CHECK (estimated_arrival_min >= 5),
    estimated_duration_min SMALLINT NOT NULL CHECK (estimated_duration_min >= 15),
    parts_included BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    edit_count SMALLINT NOT NULL DEFAULT 0 CHECK (edit_count <= 1), -- Guardrail against bait-and-switch
    sanity_alert_triggered BOOLEAN NOT NULL DEFAULT FALSE,
    status bid_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (booking_id, provider_user_id)
);

CREATE INDEX idx_bids_booking_status ON bids(booking_id, status, quoted_labor_npr);

-- On-Site Scope Change Orders (MRP Spare Parts + Extra Labor)
CREATE TABLE change_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    proposed_by UUID NOT NULL REFERENCES provider_profiles(user_id),
    reason TEXT NOT NULL,
    additional_labor_npr NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (additional_labor_npr >= 0),
    spare_parts_items JSONB NOT NULL DEFAULT '[]'::JSONB, -- [{name, qty, mrp_unit_npr, receipt_blob_path}]
    total_parts_mrp_npr NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total_parts_mrp_npr >= 0),
    status change_order_status NOT NULL DEFAULT 'PENDING_CUSTOMER_APPROVAL',
    customer_responded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Automated Calendar Slot Blocking with Database-Level Overlap Prevention
CREATE TABLE provider_calendar_slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    slot_range TSTZRANGE NOT NULL, -- [start_at - travel_buffer, end_at + travel_buffer]
    status calendar_slot_status NOT NULL DEFAULT 'LOCKED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT excl_provider_no_overlapping_locked_slots
        EXCLUDE USING GIST (
            provider_user_id WITH =,
            slot_range WITH &&
        ) WHERE (status = 'LOCKED')
);

CREATE INDEX idx_calendar_provider_range ON provider_calendar_slots USING GIST(provider_user_id, slot_range);

-- Immutable Status Audit & In-App Chat (Dispute Evidence)
CREATE TABLE booking_status_events (
    id BIGSERIAL PRIMARY KEY,
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    from_status booking_status,
    to_status booking_status NOT NULL,
    actor_user_id UUID REFERENCES users(id),
    actor_location GEOGRAPHY(POINT, 4326),
    offline_recorded_at TIMESTAMPTZ, -- For Banepa peri-urban store-and-forward sync
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE booking_chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    sender_user_id UUID NOT NULL REFERENCES users(id),
    message_text TEXT,
    media_blob_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chat_booking_time ON booking_chat_messages(booking_id, created_at);
