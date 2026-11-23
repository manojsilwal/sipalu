-- 001_extensions_and_enums.sql
-- Sipalu Platform — Core PostgreSQL Extensions & Domain Enumerations
-- Target: Azure Database for PostgreSQL Flexible Server (PostgreSQL 16+)

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- User & Identity Enums
CREATE TYPE user_role AS ENUM (
    'CUSTOMER',
    'PROVIDER',
    'BUSINESS_ADMIN',
    'OPS_DISPATCHER',
    'KYC_REVIEWER',
    'FINANCE_ADMIN',
    'GRIEVANCE_OFFICER',
    'SUPER_ADMIN'
);

CREATE TYPE kyc_document_type AS ENUM (
    'CITIZENSHIP_NAGARIKTA',
    'NATIONAL_ID_RASTRIYA'
);

CREATE TYPE kyc_status AS ENUM (
    'PENDING_SUBMISSION',
    'UNDER_ADMIN_REVIEW',
    'VERIFIED_ACTIVE',
    'REJECTED_RESUBMIT',
    'SUSPENDED'
);

CREATE TYPE provider_availability_state AS ENUM (
    'AVAILABLE',
    'EN_ROUTE',
    'ON_JOB',
    'SCHEDULED_BUSY',
    'OFFLINE'
);

-- Catalog & Booking Enums
CREATE TYPE pricing_mode AS ENUM (
    'INSTANT_FIXED',
    'LIVE_BIDDING',
    'HYBRID',
    'QUOTE_BASED'
);

CREATE TYPE booking_mode AS ENUM (
    'INSTANT_FIXED',
    'LIVE_BIDDING',
    'AMC_PREVENTIVE',
    'AMC_EMERGENCY',
    'WARRANTY_REFIX',
    'PROJECT_SURVEY'
);

CREATE TYPE urgency_level AS ENUM (
    'URGENT_ASAP',
    'SAME_DAY',
    'SCHEDULED'
);

CREATE TYPE booking_status AS ENUM (
    'CREATED',
    'LIVE_BIDDING',
    'AUTO_DISPATCHING',
    'EXPIRED_UNBID',
    'OPS_ESCALATED',
    'SCHEDULED_LOCKED',
    'EN_ROUTE',
    'ARRIVED',
    'IN_PROGRESS',
    'CHANGE_ORDER_PENDING',
    'PAUSED',
    'COMPLETED_PENDING_CONFIRM',
    'DISPUTED_ESCROW_FROZEN',
    'SETTLED_CLOSED',
    'WARRANTY_CLAIMED',
    'CANCELLED'
);

CREATE TYPE bid_status AS ENUM (
    'ACTIVE',
    'ACCEPTED',
    'REJECTED',
    'WITHDRAWN',
    'EXPIRED'
);

CREATE TYPE change_order_status AS ENUM (
    'PENDING_CUSTOMER_APPROVAL',
    'APPROVED',
    'REJECTED',
    'EXPIRED'
);

CREATE TYPE calendar_slot_status AS ENUM (
    'LOCKED',
    'COMPLETED',
    'RELEASED'
);

-- Financial & Escrow Enums
CREATE TYPE payment_method AS ENUM (
    'CASH',
    'ESEWA',
    'KHALTI',
    'FONEPAY_QR',
    'CONNECT_IPS',
    'CARD',
    'ESCROW_WALLET'
);

CREATE TYPE payment_status AS ENUM (
    'INITIATED',
    'AUTHORIZED',
    'CAPTURED',
    'FAILED',
    'REFUNDED',
    'PARTIALLY_REFUNDED'
);

CREATE TYPE escrow_status AS ENUM (
    'PENDING_FUNDING',
    'HELD',
    'FROZEN_DISPUTE',
    'PARTIALLY_RELEASED',
    'RELEASED',
    'REFUNDED'
);

CREATE TYPE payout_cadence AS ENUM (
    'INSTANT_2H',
    'SAME_DAY_BATCH',
    'WEEKLY_BANK'
);

CREATE TYPE payout_status AS ENUM (
    'QUEUED',
    'PROCESSING',
    'SETTLED',
    'FAILED',
    'REVERSED'
);

CREATE TYPE ledger_account_type AS ENUM (
    'ASSET',
    'LIABILITY',
    'REVENUE',
    'EXPENSE',
    'EQUITY'
);

-- Trust, Safety, Warranty & Governance Enums
CREATE TYPE dispute_status AS ENUM (
    'OPEN_ESCROW_FROZEN',
    'UNDER_REVIEW',
    'RESOLVED_FULL_REFUND',
    'RESOLVED_PARTIAL_ADJUSTMENT',
    'RESOLVED_PAYOUT_RELEASED',
    'RESOLVED_REWORK_DISPATCHED'
);

CREATE TYPE warranty_status AS ENUM (
    'SUBMITTED',
    'QA_APPROVED',
    'REFIX_DISPATCHED',
    'CLOSED_RESOLVED',
    'REJECTED_OUT_OF_SCOPE'
);

CREATE TYPE anti_leakage_flag_type AS ENUM (
    'GPS_PROXIMITY_CANCEL',
    'BID_TO_COMPLETION_DROP',
    'FAILED_RANDOM_SELFIE',
    'MANUAL_REPORT'
);

CREATE TYPE sos_status AS ENUM (
    'ACTIVE_P0',
    'ACKNOWLEDGED',
    'POLICE_ESCALATED',
    'RESOLVED'
);

CREATE TYPE privacy_deletion_status AS ENUM (
    'REQUESTED',
    'PROCESSING',
    'COMPLETED_ANONYMIZED'
);
