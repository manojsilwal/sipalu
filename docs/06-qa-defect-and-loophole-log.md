# 06 — QA Review, Defect & Loophole Resolution Log

This document records every bug, missing feature, edge case, and security/business loophole caught during live PostgreSQL 16 + PostGIS verification and real-browser (Playwright Chromium) human-like + adversarial testing cycles, along with root cause, fix, and retest status.

---

## QA Cycle Summary

| QA Cycle | Date (UTC) | Scope Tested | Defects / Loopholes Caught | Fixed & Verified | Result |
|---|---|---|---|---|---|
| **Cycle 0 — Live PostGIS Migrations & Seed** | 2026-11-23 | PostgreSQL 16 + PostGIS + `001..005` migrations + pilot seed | 1 (`DEF-001`) | 1 / 1 | **PASS** |
| **Cycle 1 — Real-Browser Audit #1** | 2026-11-23 | Real Chromium across Customer, Provider, Admin & B2B Portals | 1 P0 (`DEF-002`) | 1 / 1 | **FIXED → Cycle 2** |
| **Cycle 2 — Real-Browser Audit #2** | 2026-11-23 | Flows 1–4 + Loopholes L1–L4 | 1 P0 (`DEF-003`) | 1 / 1 | **FIXED → Cycle 3** |
| **Cycle 3 — Real-Browser Audit #3** | 2026-11-23 | Flows 1–5 + Loopholes L1–L4, L7, L13 | 2 (`DEF-004`, `DEF-005`) | 2 / 2 | **FIXED → Cycle 4** |
| **Cycle 4 — Full 31-Check Audit #4** | 2026-11-23 | All 4 Portals + Epics 1–7 + SOP-01–10 + Loopholes L1–L13 | 1 (`DEF-006`) | 1 / 1 | **30/31 → FIXED** |
| **Cycle 5 — Final Production Gate** | 2026-11-23 | Full 33-check suite (+ Instant 2h Payout UI + 30d Warranty Re-Fix Dispatch + Zero-404/Spurious-403 Gate) | **0 open defects** | **6 / 6** | **33/33 PASS ✓** |
| **Cycle 6 — Username/Password Auth + Nepal Gateways + Student Docker Image** | 2026-11-23 | Basic Username/Password Register→Logout→Login UI, eSewa/Khalti/Fonepay adapters, & `Dockerfile.student` container build | 1 (`DEF-007`) | **7 / 7** | **35/35 PASS ✓** |
| **Cycle 7 — Full 3-Gateway Sandbox (eSewa/Khalti/Fonepay) + Manoj/Sipalu Accounts + L14** | 2026-11-23 | Interactive eSewa/Khalti/Fonepay Sandbox Checkout → HMAC-SHA256/512 webhook settlement, Forged signature 401 check (`L14`), & `manoj`/`sipalu_customer`/`sipalu_expert` accounts | **0 open defects** | **7 / 7** | **40/40 PASS ✓** |

---

## Detailed Defect & Loophole Register

### `DEF-001` — PostgreSQL 16 Enum Cast Error in Pilot Seed (`UNION ALL`)
- **Severity:** High (Blocked fresh DB seeding)
- **Found In:** Cycle 0 (`db/seeds/001_pilot_banepa_kathmandu_seed.sql`)
- **Symptom:** `ERROR: column "pricing_mode" is of type pricing_mode but expression is of type text`.
- **Root Cause:** PostgreSQL resolves untyped string literals inside `UNION ALL` queries to `text` prior to target column coercion.
- **Fix Applied:** Explicitly cast literals (`'INSTANT_FIXED'::pricing_mode`, `'LIVE_BIDDING'::pricing_mode`, `'HYBRID'::pricing_mode`).
- **Retest:** **PASS** on live PostgreSQL 16 + PostGIS.

### `DEF-002` — P0 Server Crash on Express 4 Async Route Rejections
- **Severity:** **Critical / P0** (Could crash Azure Container Apps pods on normal `409 Conflict` / `403 Forbidden` business guardrails)
- **Found In:** Cycle 1 (Adversarial test **L3** attempting a 2nd live bid edit)
- **Symptom:** Throwing `Object.assign(new Error(...), { statusCode: 409 })` inside an `async` Express 4 handler bypassed the error middleware and exited Node.js with code `1`.
- **Root Cause:** Express 4 does not automatically forward rejected promises returned by `async` handlers to `next(err)`.
- **Fix Applied:** Added `services/api/src/asyncWrap.ts` (`wrapAsyncRouter`) wrapping every route on `authAndKycRouter`, `catalogAndBookingsRouter`, and `financeTrustOpsRouter`.
- **Retest:** **PASS** (`L3` cleanly returns HTTP `409` with zero process crash).

### `DEF-003` — P0 SQL Failure on `FOR UPDATE` with Outer Join (`/payments/initiate`)
- **Severity:** **Critical / P0** (Blocked Escrow funding and Checkout settlement)
- **Found In:** Cycle 2 (Flow 4 clicking **Fund Escrow** after Change Order approval)
- **Symptom:** PostgreSQL error `0A000: FOR UPDATE cannot be applied to the nullable side of an outer join`.
- **Root Cause:** `SELECT b.*, t.commission_rate FROM bookings b LEFT JOIN ... WHERE b.id = $1 FOR UPDATE` attempted to lock nullable outer-joined tables.
- **Fix Applied:** Audited all `FOR UPDATE` queries across `services/api/src/routes/` and updated joined booking locks to `FOR UPDATE OF b`.
- **Retest:** **PASS** (Escrow Hold, eSewa, Cash Float, and OTP Release all pass under `SERIALIZABLE` isolation).

### `DEF-004` — Provider Stuck in `ON_JOB` Availability State After Completing Work
- **Severity:** High (Broke subsequent `<60s` Instant Fixed-Price Auto-Dispatch)
- **Found In:** Cycle 3 (Flow 5 Instant Booking escalated to `OPS_ESCALATED` even though Bikram had finished Flow 4)
- **Symptom:** `provider_profiles.availability_state` remained `'ON_JOB'` after `COMPLETED_PENDING_CONFIRM` and dispute resolution.
- **Root Cause:** `POST /v1/bookings/:id/status` set `availability_state = 'ON_JOB'` when starting work, but did not restore `'AVAILABLE'` upon on-site completion (`COMPLETED_PENDING_CONFIRM`) or admin dispute closure.
- **Fix Applied:** Updated `catalogAndBookings.ts` and `financeTrustOps.ts` to reset `availability_state = 'AVAILABLE'` when a provider finishes on-site work or when a disputed job closes.
- **Retest:** **PASS** (`F5.1` Instant Fixed-Price Tap Repair auto-dispatched to `SCHEDULED_LOCKED` in `< 1s`).

### `DEF-005` — Double-Entry Escrow Liability Unwind Missing on Admin Dispute Resolution
- **Severity:** High (Financial accounting drift on disputed Escrow cases)
- **Found In:** Cycle 3 code audit while investigating `DEF-004`
- **Symptom:** Resolving a `FROZEN_DISPUTE` updated `escrow_accounts.status` without posting the offsetting debit to `SYS_ESCROW_LIABILITY` and credits to customer refund clearing / `PROV_PAYABLE`.
- **Root Cause:** Dispute resolution handler updated row status only instead of invoking `postDoubleEntryTransaction`.
- **Fix Applied:** Added idempotent, strictly balanced double-entry ledger unwind inside `/v1/admin/disputes/:disputeId/resolve`.
- **Retest:** **PASS** (`ledger_integrity.is_balanced === true` across all settlements, refunds, and payouts).

### `DEF-006` — Missing Favicon `404` & Role-Switch Race Condition Firing Spurious Admin `403`s
- **Severity:** Medium (Noisy browser console & unnecessary failed RBAC network calls)
- **Found In:** Cycle 4 (`SYS.1` browser console monitor)
- **Symptom:** Browser logged `404` for `/favicon.ico` and 4 spurious `403 Forbidden` responses when switching away from Ops Admin to Customer/Provider personas.
- **Root Cause:** `App.tsx` called `setToken(res.token)` before `setActiveTab(targetTab)`, causing `AdminOpsPortal`'s `useEffect([token])` to fire `/v1/admin/*` with the newly switched non-admin token prior to unmount.
- **Fix Applied:** Added inline SVG favicon in `apps/web/index.html`, switched `activeTab` before updating `token` in `App.tsx`, and added an explicit admin RBAC role guard in `AdminOpsPortal.tsx`.
- **Retest:** **PASS** in Cycle 5 (**Zero `404`s, zero spurious `403`s, zero JS/page errors, zero `5xx`s**).

### `DEF-007` — `Dockerfile.student` Build Failure on `apps/web/pnpm-workspace.yaml`
- **Severity:** High (Would have broken GitHub Actions GHCR build & Azure Student deploy)
- **Found In:** Cycle 6 local Docker build verification (`docker build -f Dockerfile.student`)
- **Symptom:** `pnpm run build` inside Docker failed with `ERROR packages field missing or empty`.
- **Root Cause:** `apps/web/pnpm-workspace.yaml` generated during local install lacked a `packages` field under pnpm 10 inside Docker.
- **Fix Applied:** Switched `Dockerfile.student` and `.github/workflows/ci-cd.yml` `web-build` to clean `npm install` + `npm run build` and added `.dockerignore`.
- **Retest:** **PASS** — `sipalu-student:test` built cleanly and passed full container smoke test (Web SPA + `/health` + `AUTO_MIGRATE=true` + `/v1/auth/login`).

---

## Final Production-Readiness Verification Matrix (Cycle 5 — 33/33 PASS)

- **Epics & Flows Verified:** `F1.1` WebSocket Live Sync, `F1.2` Bilingual EN/Nepali, `F1.3` Symptom Search (`pani motor chaldaina`), `F2.1–F2.2` Biometric KYC + Active Liveness + Admin Approval, `F3.1–F3.3` Live Bidding + Bid Acceptance + Post-Accept Address Unlock, `F4.1–F4.3` Execution + MRP Change Order + Escrow + P0 SOS Ack + Dispute Resolution, `F5.1–F5.2` Instant `<60s` Auto-Dispatch + Two-Way Rating Ranking Loop + 30-Day Warranty Claim, `F7.1–F7.3` B2B AMC `<2h` Emergency + Turnkey Renovation 6m Warranty + Admin Warranty Re-Fix Dispatch + Provider Instant 2h Payout (`Rs 500` Gross / `Rs 25` Fee / `Rs 475` Net).
- **All 13 Adversarial Loopholes Closed (`L1`–`L13`):**
  - `L1` / `L1.2` Unverified & unlinked bank/eSewa provider blocked (`403` / `400`).
  - `L2` Overlapping calendar slot bid blocked by Automated Calendar + PostgreSQL GiST exclusion (`409`).
  - `L3` Bait-and-switch >1 bid edit blocked (`409`).
  - `L4` Exact homeowner address & GPS pin masked during bidding.
  - `L5` Cash-Job Commission Float auto-pauses below `-NPR 300` (`-440 NPR`) and blocks cash bids (`403`).
  - `L6` Commission charged strictly on labor (`18% × 350 = 63 NPR`), `0%` on `Rs 100` visiting fee & `100%` tips.
  - `L7` Escrow release strictly blocked (`409`) while 48h dispute is `FROZEN_DISPUTE`.
  - `L8` PostGIS `ST_Distance <= 300m` (`14.84m`) cancellation auto-creates `GPS_PROXIMITY_CANCEL` anti-leakage flag.
  - `L9` Warranty claim on cancelled/unsettled booking rejected (`400`).
  - `L10` Replay payment with duplicate `Idempotency-Key` cleanly deduplicated (`deduplicated: true`).
  - `L11` 7-Day PII Anonymization scrubs PII & revokes session (`401`) while keeping Double-Entry Ledger `BALANCED ✓`.
  - `L12.1` / `L12.2` Pending Random Selfie Re-Check blocks `AVAILABLE` (`428`) until active liveness passes.
  - `L13` P0 SOS alert triggers live banner with GPS coordinates & ACS bridge ID in Ops Command Center.
