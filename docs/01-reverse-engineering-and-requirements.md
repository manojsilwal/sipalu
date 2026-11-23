# 01 — Reverse Engineering, Gap Analysis & Unified Requirements Specification

## 1. Executive Synthesis: Merging Sajilo Sewa + Founder PRD

This specification merges two complementary foundations into a single, market-leading blueprint for **Sipalu**:
1. **Founder's Core PRD (v1.0 — Pilot-First Plumbing & Mechanical Marketplace):** Brings strong marketplace differentiators—**Live Competitive Bidding**, **Biometric Facial Recognition + Liveness KYC**, **Mandatory Bank/eSewa Linking**, **Automated Calendar Slot Blocking & Conflict Prevention**, **Ranking with Inactivity/Zero-Job Decay & New-Provider Grace**, **Escrow/Milestone Protection**, **GPS-based Anti-Leakage Detection**, **Two-Way Ratings**, **SOS Emergency Safety**, and a disciplined **Kathmandu Valley + Banepa Pilot**.
2. **Reverse-Engineered Sajilo Sewa Ecosystem (`sajilosewa.com`, `app.sms.smsuser`, `app.sms.smstechnician`):** Brings proven Nepal scale mechanics—**10 service verticals (400+ SKUs)**, **<60s Instant Rate-Card Booking**, **Natural-Language Symptom Search**, **4-Tier Commission Progression (`22% → 12%`)**, **30-Day Service & 6-Month Project Warranties**, **Twice-Daily/Instant Payouts**, **Khalti/Fonepay/ConnectIPS**, **B2B AMC Contracts (`<2h` SLA)**, **Turnkey Renovation (`Project`)**, **Service Business Fleet Mode**, and **Nepal Regulatory Compliance (VAT, Form 11, Grievance Officer, 7-day deletion)**.

---

## 2. Explicit Gap Analysis: What Was Missed & How We Improved It

| # | Area | Original Founder PRD (v1.0) | Gap Identified | Unified Sipalu Improvement (v2.0) |
|---|---|---|---|---|
| **1** | **Pricing & Booking Friction** | Live Bidding only (10–15 min wait for every job) | Homeowners with simple repairs (leaking tap, flush tank) abandon 15-min bidding waits if a competitor offers instant 60s fixed pricing | **Hybrid Booking Engine:** Standardized SKUs default to **Instant Fixed-Price (<60s)**; complex/diagnostic/multi-issue requests route to **Live Competitive Bidding (10–15m)**—or customer can toggle *"Get Bids"* |
| **2** | **Cash-Job Commission Leakage** | Mentions prepaid commission balance / linked bank settlement | Missing concrete float thresholds, credit-limit cutoffs, and settlement enforcement when technicians collect cash | **Prepaid Commission Wallet (Float):** Technicians maintain a minimum float (e.g., `NPR 500`); cash jobs auto-deduct commission from float. If float drops below `-NPR 300`, cash-job eligibility auto-pauses until topped up via eSewa/Khalti/auto-netting from digital payouts |
| **3** | **Post-Job Warranty vs. Dispute Window** | 48-hour dispute window only | Plumbing/mechanical defects (slow pipe leaks, pump seals) often appear 5–20 days later; 48h window loses trust vs. Sajilo Sewa's 30-day guarantee | **Layered Protection:** Keep **48-hour Dispute & Escrow Freeze** for immediate billing/no-show/damage disputes, PLUS **30-Day Workmanship Warranty** (standard repairs, hourly platform-paid re-fix) and **6-Month Warranty** (major/renovation projects) |
| **4** | **Spare Parts & Travel Transparency** | Note in bid if parts included; on-site Change Order | Technicians often inflate bids for travel or mark up spare parts opaque to customers | **MRP Pass-Through & Visiting Fee Protection:** Spare parts billed strictly at **MRP (zero platform commission)** via photo-receipt Change Order; flat **`NPR 100` visiting/travel fee** + **100% tips** pass directly to technician |
| **5** | **Technician Retention & Anti-Leakage Carrot** | Relied primarily on penalties (masked calls, GPS flags, warranty loss) | Sticks alone don't stop top technicians from taking repeat clients off-platform if commission stays flat | **4-Tier Commission Ladder (`22% → 12%`) + Fast Payouts:** Reward volume & `>= 4.4` rating with lower commission, priority dispatch, tool loans (`NPR 15k–25k`), public liability insurance (`NPR 25 lakh`), and **Instant (2h) / Twice-Daily Free Payouts** |
| **6** | **Payment Ecosystem Coverage** | Cash + eSewa + Escrow | Nepal urban users heavily use **Khalti**, **Fonepay QR**, and **ConnectIPS** alongside eSewa | Add **Khalti, Fonepay QR, ConnectIPS**, and bank settlement (NMB, NIBL, Nabil, NIC Asia) with unified idempotent webhook processing |
| **7** | **Supply Stability & Off-Peak Revenue** | Individual residential technicians only | Solo residential demand is spiky; no B2B recurring contracts or multi-tech vendor shops | Add **Service Business Fleet Mode** (shops managing 2–20 technicians) and **B2B AMC Subscriptions** (recurring preventive maintenance + `<2h` emergency SLA) in Phase 2–3 |
| **8** | **Discovery, Retention & Growth** | Category selection in mobile app | No SEO customer web funnel, no symptom-based NL search, no promos/loyalty/preferred-pro repeat booking | Add **SEO Next.js Customer Web**, **Azure AI Search Symptom Discovery** (*"water pump not lifting water"*), **Promo Codes & Loyalty Points**, and **Request Preferred Technician** |
| **9** | **Nepal Legal, Tax & Data Governance** | High-level encryption & RBAC mention | Missing VAT invoicing, technician Form 11 tax compliance, Grievance Officer role, and explicit account/data deletion SLA | Formalize **VAT-compliant PDF Invoices**, **Form 11 annual tax export**, **Optional 50% PF/SSF matching**, **Grievance Officer escalation**, and **7-working-day PII Anonymization** (preserving statutory tax ledgers) |
| **10** | **Peri-Urban Offline Resilience (Banepa)** | Mentioned offline queuing in NFR | Needed concrete sync semantics for unstable 3G/4G during live bidding, GPS tracking, and photo uploads | Specify **Store-and-Forward Local Queue** (SQLite/WatermelonDB on mobile), optimistic check-in timestamps with GPS proof, resumable chunked SAS uploads to Azure Blob, and SMS fallback for critical dispatch alerts |

---

## 3. Reverse-Engineered Service Catalog & Phased Vertical Roadmap

### Phase 1 Pilot Verticals (Banepa & Select Kathmandu Valley Wards)
| Category | Core Pilot Subcategories | Pricing Mode | Representative Services & Benchmark NPR |
|---|---|---|---|
| **1. Plumbing** | Bathroom, Toilet & Urinal, Kitchen, Pipelines & Water Flow, Motor & Pump, Solar Water Heater, Filter Vessel / RO | **Hybrid** (Instant Fixed for standard + Live Bid for complex leaks/piping) | Consultation (`Rs 650`), Tap/Faucet Leakage (`Rs 350`), Flush Tank Repair (`Rs 650–1,200`), Mixer Install (`Rs 800–1,200`), Commode Install (`Rs 2,250`), Water Pump/Motor Repair (Bid / `Rs 650+`), Solar Rod Replace (`Rs 2,000`), Tube Solar Servicing (`Rs 7,000`) |
| **2. Mechanical & Utility Fixtures** | Water Pumps, Pressure Boosters, Geysers, Solar Thermal, Overhead/Reserve Tank Piping, Mechanical Valves & Fixtures | **Hybrid** (Inspection + Live Bid / Escrow for major replacements) | Pump Motor Rewinding/Replacement (Bid/Escrow), Geyser Heating Element/Thermostat (Instant/Bid), Pipeline Rerouting & Pressure Testing (Bid/Escrow) |

### Phase 2–3 Expansion Verticals (Full Sajilo Sewa Parity — 10 Categories, 400+ Services)
| # | Category | Observed Subcategories | Representative Pricing (NPR) |
|---|---|---|---|
| 3 | **Electrical** (87+ SKUs) | Inspection, Lighting, Switches/Sockets, Wiring, MCB, Networking, Intercom, Fan, TV Mount, CCTV, Earthing, UPS/Inverter | Consultation (`Rs 650`), Socket (`Rs 500`), Switch Board (`Rs 600`), TV Install (`Rs 900–1,800`), CCTV (`Rs 1,200`), Inverter (`Rs 1,200`), DB Replacement (`Rs 4,500`) |
| 4 | **AC & Appliances** (18+ SKUs) | Split/Cassette AC, Refrigerator, Deep Freezer, Microwave Oven | Inspection (`Rs 500`), Fridge/Microwave Servicing (`Rs 1,000`), AC Servicing (`Rs 1,650–2,750`), AC Gas Refill (`Rs 4,675`), Wall AC Install (`Rs 4,972`) |
| 5 | **Washing Machine** (4+ SKUs) | Inspection, Normal & Deep Servicing | Inspection (`Rs 500`), Normal Servicing (`Rs 1,500`), Deep Servicing (`Rs 3,500`) |
| 6 | **Cleaning & Pest Control** (30+ SKUs) | Home Cleaning (1–5 BHK), Tank Cleaning (1000L–5000L), Pest Control, Floor Polishing, Sofa/Carpet/Chimney | Tank Cleaning (`Rs 1,500–4,000`), Sofa/Carpet (`Rs 3,400`), 1–5 BHK Basic (`Rs 5,000–9,500`) |
| 7 | **Computer & IT Repair** (40+ SKUs) | Inspection, Laptop/Gaming/MacBook Servicing, Display/Hinge, OS/Software, Remote AnyDesk, Data Recovery, Motherboard | Inspection / AnyDesk Remote (`Rs 500`), Laptop Servicing (`Rs 1,500–3,500`), Data Recovery (`Rs 2,000`), Motherboard (`Rs 4,500–6,000`) |
| 8 | **Office Maintenance (B2B AMC)** | Plumbing AMC, Electrical AMC, Computer AMC, AC AMC, Cleaning AMC, General Office Repairs | General Repairs (`Rs 1,000`), Custom Tiered Annual Contract (`<2h` Emergency SLA) |
| 9 | **Home/Office Renovation (`Project`)** | Bathroom, Kitchen, Waterproofing, Painting, False Ceiling, Flat Renovation, Room Extension | Free 48h Site Survey -> Itemized BOQ -> Escrow Milestones -> 6-Month Warranty |
| 10 | **EV Charger & Automobile/Bluebook** | EV Charger Inspection/Install (3KW), Bluebook Renewal, Ownership Transfer, Zonal Registration | 3KW EV Charger Install (`Rs 3,000`), 2W/4W Zonal Registration (`Rs 350–500`), Re-registration (`Rs 2,000`) |

---

## 4. Unified Functional Requirements (FR)

### 4.1 Customer Web & Mobile (`FR-CUST`)
- **FR-CUST-01 Geo-Zone & Neighborhood Privacy:** Select city/ward (Kathmandu, Lalitpur, Bhaktapur, Banepa, Pokhara). Pin exact location via map; expose **only approximate neighborhood/distance** during bidding, unlocking exact address & pin only upon booking confirmation.
- **FR-CUST-02 Natural Language & Faceted Discovery:** Symptom search (*"kitchen tap leaking"*, *"water pump humming"*) via Azure AI Search + category/subcategory/rating/price filters.
- **FR-CUST-03 Hybrid Booking (Instant Fixed-Price + Live Bidding):**
  - *Instant Mode:* Select SKU + quantity + date (rolling 7+ days) + 2-hour arrival slot (`8AM–6PM`) -> confirm in `<60s`.
  - *Live Bidding Mode:* Describe issue with text/voice/photos/video + urgency (`ASAP` 10–15m window vs `Scheduled`) -> compare live bids (price, ETA, duration, parts note, verified badge, rating, completed jobs) -> select winning bid.
- **FR-CUST-04 Real-Time GPS, Masked Calling & Audit Chat:** Watch technician live GPS & dynamic ETA once `En Route`; communicate via masked VoIP/PSTN calling and in-app media chat.
- **FR-CUST-05 In-App Change Orders & Escrow Milestones:** Explicitly approve/reject on-site scope or MRP spare-parts Change Orders; authorize Escrow funds and release milestones via in-app confirmation/OTP.
- **FR-CUST-06 Multi-Modal Checkout, Promos & Loyalty:** Pay via **eSewa, Khalti, Fonepay QR, ConnectIPS, Card, Escrow, or Cash**; apply promo codes & loyalty points; receive VAT-compliant PDF receipt.
- **FR-CUST-07 Ratings, Preferred Pro, Disputes, Warranty & SOS:** Submit 1–5 star rating with sub-tags (`punctuality`, `workmanship`, `cleanliness`, `pricing transparency`); request preferred repeat technician; trigger **SOS Emergency** during active jobs; file **48h Dispute (Escrow Freeze)** or **30-Day / 6-Month Warranty Claim**.

### 4.2 Provider / Technician App & Fleet Portal (`FR-PROV`)
- **FR-PROV-01 Strict Biometric KYC & Financial Linking:** Upload Citizenship (*Nagarikta*) or National ID (*Rastriya Parichayapatra*) front/back + real-time **Facial Recognition & Liveness Check** + mandatory **Bank Account and/or eSewa linking** before activation. Support **periodic random selfie re-checks** to prevent account sharing.
- **FR-PROV-02 Live Bidding & Instant Dispatch Hub:** Receive local broadcasts matching trade & radius; submit bids (NPR price, ETA, estimated duration, parts note) within time-boxed windows with edit caps and sanity bounds; accept/decline instant rate-card dispatches.
- **FR-PROV-03 Automated Calendar & Conflict Prevention:** Auto-block accepted job start time + estimated duration + travel buffer; auto-block overlapping bids; manage real-time states (`Available`, `En Route`, `On Job`, `Scheduled Busy`, `Offline`) and mutual reschedule flow.
- **FR-PROV-04 Job Execution, Change Orders & PDF Invoicing:** One-tap `En Route` (GPS on), geo-fenced check-in, `Start/Pause/Complete` timer, before/after photos, in-app Change Order submission (parts at MRP with receipt photo), and PDF estimate/invoice generation.
- **FR-PROV-05 Commission Wallet (Float), Tiers & Payouts:** Track prepaid Cash-Job Commission Float, live `Trainee → Verified → Pro → Elite` tier progress (`22% → 12%` commission), ranking scorecard (rating, completion, bid speed, decay warnings), and trigger **Instant (2h)**, **Twice-Daily (11AM/5PM)**, or **Weekly Monday** payouts.
- **FR-PROV-06 Fleet Mode, Two-Way Rating & In-App Support:** Business partners manage crews & dispatch; technicians rate customer cooperation; raise support/tool-loan tickets and SOS alerts in-app.

### 4.3 Operations, Trust & Admin Web Portal (`FR-ADM`)
- **FR-ADM-01 Biometric KYC & Academy Queue:** Side-by-side ID document view, Azure Face match confidence score, liveness pass/fail, bank/eSewa verification status, Academy test score, and `Approve / Request Resubmission / Reject / Suspend` actions.
- **FR-ADM-02 Live Operations & SLA Command Center:** Real-time map of active jobs, unbid urgent requests (`>5m` alert), unmatched instant orders (`>90s` alert), delayed arrivals, and **SOS Emergency** priority dashboard.
- **FR-ADM-03 Anti-Leakage & Fraud Monitor:** Automated anomaly queue flagging technicians who cancel accepted bids after nearing customer GPS coordinates, abnormal bid-to-completion drops, or failed random selfie checks.
- **FR-ADM-04 Financial, Escrow & Reconciliation Console:** Double-entry ledger, Escrow hold/freeze/release controls, cash-float monitoring, gateway reconciliation (eSewa/Khalti/Fonepay/ConnectIPS), batch payouts, and annual Form 11 tax exports.
- **FR-ADM-05 Dispute, Warranty & Grievance Center:** Unified evidence dossier (original bid, approved Change Orders, chat logs, masked call metadata, before/after photos, GPS arrival/departure timestamps) for 24–48h dispute resolution, 30-day/6-month warranty dispatch, and 7-working-day PII deletion.
- **FR-ADM-06 B2B AMC & Renovation Project Module:** Manage commercial AMC asset registries, preventive visit calendars, `<2h` emergency timers, and 48h site survey -> BOQ -> milestone project workflows.

---

## 5. Non-Functional Requirements (NFR)

| Dimension | Specification |
|---|---|
| **Latency & Real-Time** | Web SSR TTFB `<300ms`; API p95 `<250ms` from Kathmandu/Banepa; live bid broadcast & GPS WebSocket fan-out `<500ms` |
| **Offline & Peri-Urban Resilience** | Mobile local store-and-forward queue for Banepa/peri-urban weak 4G; resumable photo uploads; SMS fallback for critical bid acceptance & SOS |
| **Availability & Financial Integrity** | `99.9%` uptime (multi-AZ Azure); strict ACID double-entry ledger & Escrow state machine; mandatory idempotency keys on all payments/payouts |
| **Biometric & Data Security** | TLS 1.3 + AES-256 at rest; encrypted KYC & facial biometric templates (never exposed via public URLs; 5-min expiring SAS); RBAC with audit logs; 7-working-day PII anonymization |
| **Localization & Accessibility** | Bilingual **Nepali (नेपाली) + English**, `NPR (Rs.)` formatting, dual **Bikram Sambat (BS) / Gregorian (AD)** dates, icon-first UI for varying technician digital literacy |
| **Scalability** | Modular Azure microservices supporting Phase 1 pilot (50–200 technicians) scaling seamlessly to 10,000+ experts & 500k+ households nationwide without re-architecture |
