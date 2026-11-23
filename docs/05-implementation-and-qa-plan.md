# 05 — End-to-End Implementation Plan & Real-Browser QA Loop

This plan translates **PRD v2.0** (`02-prd.md`), **Azure Architecture v2.0** (`03-azure-cloud-architecture.md`), and **SOP-01 through SOP-10** (`04-sops.md`) into a production-ready monorepo, backed by real **PostgreSQL 16 + PostGIS + Redis**, and verified through an iterative **real-browser (Playwright Chromium) human-like + adversarial loophole QA loop**.

---

## 1. Monorepo Architecture & Azure Parity

```text
sipalu/
├── docker-compose.yml          # Local PostgreSQL 16 + PostGIS + Redis (mirrors Azure PaaS)
├── db/
│   ├── migrations/             # 001..005 SQL migrations (PostGIS, btree_gist, Double-Entry Ledger)
│   └── seeds/                  # Banepa & Kathmandu Valley pilot seed data
├── api/
│   └── openapi.yaml            # OpenAPI 3.1 contract
├── infra/bicep/                # Azure Bicep IaC (Central India Pilot & Scale profiles)
├── services/api/               # Node.js 22 + TypeScript + Express + pg + ioredis + ws (ACA-ready)
│   ├── Dockerfile              # Multi-stage production container for Azure Container Registry
│   └── src/
│       ├── db.ts               # PostgreSQL Pool + ACID Serializable transaction helper
│       ├── redis.ts            # Redis client + graceful fallback + Geo/TTL helpers
│       ├── ws.ts               # Real-time WebSocket hub (mirrors Azure Web PubSub)
│       ├── auth.ts             # OTP + JWT + RBAC middleware
│       ├── ledger.ts           # Double-entry accounting engine, Escrow, Cash Float, Tiers
│       ├── ranking.ts          # Composite Visibility Score + 14d Inactivity Decay + New Grace
│       └── routes/             # Modular domain routers covering all 7 Epics & 10 SOPs
├── apps/web/                   # React + Vite + TypeScript + Vanilla CSS Design System
│   ├── Dockerfile              # Production nginx/SSR container
│   └── src/
│       ├── styles/             # Curated Sipalu design tokens & responsive layouts (EN/NP)
│       ├── portals/
│       │   ├── CustomerPortal.tsx   # Discovery, Hybrid Booking, Live Bids, GPS/Chat, Checkout, Disputes/Warranty, SOS
│       │   ├── ProviderPortal.tsx   # Biometric KYC, Random Selfie Gate, Bidding, GiST Calendar, Change Orders, Float/Payouts
│       │   ├── AdminOpsPortal.tsx   # KYC Queue, Live SLA/SOS Monitor, Anti-Leakage Flags, Disputes, Warranty QA, Ledger, Privacy
│       │   └── B2bProjectPortal.tsx # B2B AMC (<2h Emergency) & Turnkey Renovation (48h Survey, BOQ, Milestones, 6m Warranty)
└── qa/
    └── browser-e2e/            # Real Chromium Playwright human-like & adversarial loophole test loop
```

---

## 2. Implementation Milestones & PRD/SOP Coverage Matrix

| Milestone | Scope | PRD Epics & SOPs Covered | Exit Gate |
|---|---|---|---|
| **M0 — Local Azure-Parity Runtime** | Docker `postgis/postgis:16-3.4-alpine` + `redis:7-alpine`; apply all 5 SQL migrations + pilot seed; verify zero migration errors | Schema + `SOP-10` | All 6 SQL scripts execute cleanly on live PostGIS |
| **M1 — Core Backend API & Financial Engine** | Express/TS API + WebSocket hub: Auth/OTP, Biometric KYC + Random Selfie `428` gate, Hybrid Booking + Live Bidding (edit cap `<=1`, sanity bounds, neighborhood masking), GiST Calendar Lock, Change Orders (MRP parts), Double-Entry Ledger + Cash Float (`-300 NPR` pause) + Escrow Freeze/Release + Idempotent Webhooks/Payouts, Ranking & Decay, Anti-Leakage GPS (`<=300m`), P0 SOS, 48h Disputes, 30d/6m Warranties, B2B AMC, Turnkey Projects, 7d Privacy Anonymization | `Epic 1–7`, `SOP-01` to `SOP-09` | API unit/integration sanity + double-entry balance invariant `SUM(debit) == SUM(credit)` |
| **M2 — Multi-Portal Web Application** | Responsive, bilingual (`EN / नेपाली`) Vanilla CSS UI with Customer Marketplace, Provider Hub, Admin/Ops Command Center, and B2B AMC/Project Portal wired to live API + WebSockets | All UI journeys + accessibility + SEO | Zero build/TS errors, zero console errors |
| **M3 — Real-Browser Human & Adversarial QA Loop** | Real Chromium browser (Playwright) simulates real human flows across all 4 portals + **13 adversarial loophole probes** (L1–L13), captures screenshots & network logs | 100% PRD + `SOP-01` to `SOP-10` | Every defect/loophole logged in `06-qa-defect-and-loophole-log.md`, fixed, and re-verified green |
| **M4 — Production Readiness & CI/CD** | Production Dockerfiles, GitHub Actions CI/CD (lint, typecheck, SQL migration test, Playwright E2E, Bicep lint), `main` push | `SOP-10` Production Gate | Clean build, 100% passing E2E loop, zero open P0/P1 defects |

---

## 3. Mandatory Adversarial Loophole Checklist (Tested in Real Browser)

Every QA cycle MUST explicitly probe and verify these **13 critical loopholes**:

1. **L1 — Unverified / Unlinked Financial Bypass:** Provider without approved Biometric KYC OR without verified bank/eSewa account MUST be blocked from going `AVAILABLE` or placing live bids.
2. **L2 — Overlapping Calendar Double-Booking:** Provider with a `LOCKED` slot MUST be rejected (HTTP `409`) by both API & PostgreSQL `EXCLUDE USING GIST` if attempting to bid/accept an overlapping job (including travel buffer).
3. **L3 — Bait-and-Switch Bid Manipulation:** Provider MUST NOT edit an active bid more than `1` time, nor bid after `bidding_closes_at`.
4. **L4 — Pre-Acceptance Address Privacy Leak:** During `LIVE_BIDDING`, API & UI MUST expose ONLY `tole_neighborhood` and `masked_location` (~500m jitter)—NEVER `exact_address_line` or `exact_location` until bid acceptance.
5. **L5 — Cash-Job Commission Debt Leakage:** When `provider_float_wallets.current_float_npr < -300.00`, cash-job eligibility MUST auto-pause (`is_cash_paused = TRUE`) until topped up or netted by digital earnings.
6. **L6 — Commission Over-Deduction Bug:** Platform commission (`22% → 12%`) MUST apply **strictly to labor** (`quoted_labor + approved_change_order_labor`) and NEVER deduct from `NPR 100` visiting fee, `100%` customer tips, or `MRP` spare parts.
7. **L7 — Escrow Release During Active Dispute:** Attempting to release Escrow while a 48-hour dispute is `OPEN_ESCROW_FROZEN` MUST fail with HTTP `409`.
8. **L8 — GPS Proximity Cancellation (Off-Platform Leakage):** Provider cancelling a `SCHEDULED_LOCKED` / `EN_ROUTE` booking after recording GPS within `<= 300m` of the customer's exact pin MUST auto-create an `ANTI_LEAKAGE_FLAG` (`GPS_PROXIMITY_CANCEL`) in Admin Ops.
9. **L9 — Invalid / Expired Warranty Claim:** Claiming a 30-day warranty on a cancelled, unpaid, or `> 30 days` expired job MUST be rejected cleanly.
10. **L10 — Double-Credit / Double-Payout Replay Attack:** Replaying a payment webhook or payout request with the same `Idempotency-Key` MUST return the original result without creating duplicate `ledger_entries`.
11. **L11 — 7-Day Privacy Deletion vs. Statutory Ledger Retention:** Executing `Privacy Deletion` MUST anonymize `users` (`full_name`, `phone_e164`, `email`) and `user_addresses`, while keeping `ledger_entries` & `bookings` intact for VAT/tax compliance.
12. **L12 — Random Selfie Re-Check Bypass:** When a provider has a pending `random_selfie_checks` record, toggling `AVAILABLE` MUST return HTTP `428 Precondition Required` and prompt liveness verification in the UI.
13. **L13 — P0 SOS Safety Broadcast:** Pressing **SOS** during an active job MUST immediately persist a `sos_events` (`ACTIVE_P0`) record with live GPS and surface a live red alert banner in the Admin Command Center.
