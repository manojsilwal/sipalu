# 04 — Unified Standard Operating Procedures (SOPs): Operations, Trust & Azure SRE

This playbook defines the **10 Standard Operating Procedures** governing **Sipalu** from **Phase 1 Pilot (Banepa & Kathmandu Valley)** through nationwide multi-vertical scale.

---

## SOP Master Index

| ID | Procedure | Primary Owner | Target SLA / Cadence |
|---|---|---|---|
| **SOP-01** | Biometric KYC Verification, Financial Linking & Random Selfie Checks | Trust & Onboarding Team | 24–48h review / 14–30d re-check |
| **SOP-02** | Hybrid Booking, Live Bidding & 60-Sec Auto-Dispatch Loop | Dispatch Ops & Field Techs | 60s Instant / 10–15m Bid / 90s Escalation |
| **SOP-03** | On-Site Execution, Change Orders & Automated Calendar Rescheduling | Field Technicians & Ops | Real-time approval / Mutual reschedule |
| **SOP-04** | Cash-Job Commission Float, Escrow Milestones & Multi-Cadence Payouts | Finance & Automated Ledger | 2h Instant / 11AM & 5PM / Mon / 23:30 Recon |
| **SOP-05** | 48-Hour Dispute Resolution & Escrow Freeze Protocol | Disputes & Trust Team | Instant freeze / 24–48h resolution |
| **SOP-06** | 30-Day Service & 6-Month Project Warranty Re-Fix Handling | Quality Assurance (QA) | 4h triage / 24h free revisit |
| **SOP-07** | Anti-Leakage Enforcement, Account Cooldowns & SOS Emergency Safety | Trust, Safety & 24×7 Ops | SOS `<60s` response / Daily anomaly audit |
| **SOP-08** | B2B AMC Contract Operations & `<2h` Emergency Response | B2B Account & Facility Ops | 48h audit / `<2h` emergency arrival |
| **SOP-09** | Turnkey Renovation (`Project`) Survey, BOQ & Supervision + Privacy/Grievance | PMO & Grievance Officer | 48h survey / 7-working-day PII deletion |
| **SOP-10** | Azure Cloud SRE, Incident Response, Biometric Vault & Backup/DR | Cloud Platform & SRE | SEV-1 `<15m` ack / RPO `<5m` / RTO `<30m` |

---

## SOP-01: Biometric KYC Verification, Financial Linking & Random Selfie Checks

- **Trigger:** Technician or Service Business registers via Provider App or `/become-an-expert`.
- **SLA:** Automated biometric check `<30s`; Admin KYC review within **24–48 hours**.
- **Procedure:**
  1. **Document & Biometric Capture:** Applicant uploads front/back of valid Nepali **Citizenship (*Nagarikta*)** or **National ID (*Rastriya Parichayapatra*)** and completes a live selfie with **Azure AI Vision Active Liveness**.
  2. **Automated Triage:**
     - Face Match `>= 0.85` + Liveness Pass → routes to Fast-Track Admin verification.
     - Face Match `0.70–0.84` → routes to Senior Reviewer manual comparison + video call verification.
     - Face Match `< 0.70` or Liveness Fail → auto-rejected with actionable resubmission prompt.
  3. **Mandatory Financial Linking:** Applicant links & verifies a Nepali bank account and/or eSewa/Khalti wallet (penny-drop or account-holder name match against Citizenship/ID) and funds initial **Cash-Job Commission Float** (`NPR 500` recommended; or starts digital-only until earned).
  4. **Academy Assessment & Activation:** Trade verification call/practical test → assign **Trainee** tier (`22%` commission) + **14-day "New Verified" grace badge** + uniform/ID kit + NPR 25L public liability coverage.
  5. **Periodic Random Selfie Re-Checks:** Every 14–30 days (or upon device change/anti-leakage flag), Provider App requires a live selfie before toggling `Available`. Failed re-checks auto-suspend the account pending Trust review.

---

## SOP-02: Hybrid Booking, Live Bidding & 60-Sec Auto-Dispatch Loop

- **Trigger:** Homeowner submits an Instant Rate-Card booking or a Live Bidding request.
- **SLA:** Instant match `<= 60s` (Ops escalation at `90s`); Live Bidding window `10–15 min` (Urgent) with `<3 min` target to first bid.
- **Procedure:**
  1. **Address Masking & Conflict Filtering:** System exposes only approximate neighborhood/distance during bidding and automatically excludes technicians with overlapping calendar blocks or paused cash floats.
  2. **Instant Fixed-Price Path:** Auto-dispatches to top ranked available technicians (`Elite/Pro/Verified/Trainee` + proximity) with 45s accept TTL. If unmatched at `90s`, enters **Ops Command Center** red queue for manual assignment within 5 min.
  3. **Live Bidding Path:** Broadcasts request (description, photos/video, neighborhood) to nearby qualified technicians. Enforces max **1 bid edit** and min/max price sanity prompts. If `0` bids arrive within **5 minutes** on an Urgent request, Ops widens radius / calls standby Banepa/KTM technicians.
  4. **Bid Selection & Calendar Lock:** Upon customer selection, system atomically locks `[Start - Travel_Buffer, End + Travel_Buffer]` on the technician's calendar, unlocks the exact street address & GPS pin, and authorizes Escrow (for jobs `> NPR 5,000` or milestone jobs).

---

## SOP-03: On-Site Execution, Change Orders & Automated Calendar Rescheduling

- **Trigger:** Technician starts travel (`En Route`) for a confirmed booking.
- **Procedure:**
  1. **En Route & Tracking:** Technician taps `En Route` → live GPS streams via Azure Web PubSub; masked VoIP/PSTN call and in-app chat activate.
  2. **Check-In & Inspection:** Technician checks in on arrival (geo-fence/OTP) and captures "Before" photo.
  3. **On-Site Scope Change (Change Order Protocol):**
     - If hidden damage or replacement parts are required, technician submits an itemized **Change Order** in-app specifying extra labor and spare parts **at MRP with receipt photo** (zero markup).
     - Customer receives instant push notification and must tap **Approve** before extra work proceeds.
     - *Never* accept verbal-only price hikes; unapproved verbal additions are non-recoverable in disputes.
  4. **Completion & Offline Resilience:** Technician captures "After" photos, taps `Complete`, and collects payment/OTP confirmation. If 4G drops (e.g., peri-urban Banepa), the app queues signed timestamps/photos locally and syncs automatically upon reconnect.
  5. **Rescheduling:** Either party initiates reschedule in-app; calendar slot moves **only upon mutual confirmation** (releasing old slot cleanly).

---

## SOP-04: Cash-Job Commission Float, Escrow Milestones & Multi-Cadence Payouts

- **Trigger:** Job completion, Instant withdrawal request, or scheduled batch (`11:00 AM` / `5:00 PM` / `Monday 09:00 AM` / `23:30` daily recon / `1st of month` tier cron).
- **Procedure:**
  1. **Commission Calculation:** Deduct active tier commission (`22%` Trainee, `18%` Verified, `15%` Pro, `12%` Elite) strictly from **labor revenue**. Credit `NPR 100` visiting fee, `100%` tips, and `MRP` spare parts untouched to provider.
  2. **Cash-Job Float Enforcement:**
     - Commission on Cash-on-Completion jobs deducts immediately from `provider_float_wallet`.
     - Warning alert at float `< NPR 100`; **automatic Cash-Job pause** at float `< -NPR 300` (provider remains eligible for Digital/Escrow jobs, whose net earnings auto-replenish the float).
  3. **Escrow Release:** Funds held in `customer_escrow` release automatically to `provider_payable` upon homeowner OTP/in-app sign-off (or auto-release after **48 hours** if no dispute is filed and completion proof exists).
  4. **Payout Execution:**
     - *Instant (2h SLA):* `NPR 25` fee via eSewa/Khalti/IME using strict idempotency keys.
     - *Same-Day Batch (11:00 AM & 5:00 PM NPT):* Free to wallets + ConnectIPS.
     - *Weekly Bank Settle (Monday 09:00 AM NPT):* Free bank transfer (NMB, NIBL, Nabil, NIC Asia).
  5. **Daily Reconciliation (`23:30 NPT`) & Monthly Tier Cron:** Reconcile internal ledger vs gateway settlement reports (`> NPR 1` mismatch alerts Finance before morning batch). On the 1st of each month, auto-promote technicians meeting lifetime job thresholds + `rating >= 4.4`; coach before demoting anyone `< 4.0` for 2 consecutive months.

---

## SOP-05: 48-Hour Dispute Resolution & Escrow Freeze Protocol

- **Trigger:** Homeowner or Technician raises an in-app dispute within **48 hours** of job completion (incomplete repair, workmanship defect, overcharging, no-show, or property damage).
- **SLA:** Instant automated Escrow freeze; Admin resolution within **24–48 hours**.
- **Procedure:**
  1. **Automatic Freeze:** Filing a dispute immediately transitions `escrow_status` to `FROZEN` (or places a temporary hold on unsettled provider balance for non-escrow digital jobs).
  2. **Evidence Dossier Review:** Dispute specialist inspects the unified platform record: original request/bid, approved Change Orders + MRP receipts, masked call logs, in-app chat transcripts, before/after photos, and GPS arrival/departure timestamps.
  3. **Resolution Outcomes:** Admin issues one of four binding rulings logged with audit notes:
     - **Full Refund** to customer (e.g., verified no-show or unperformed work).
     - **Partial Adjustment** (e.g., removing unapproved verbal surcharges).
     - **Payout Release** to technician (when objective proof confirms compliant completion).
     - **Rework Dispatch** (assigning free corrective visit under QA oversight).

---

## SOP-06: 30-Day Service & 6-Month Project Warranty Re-Fix Handling

- **Trigger:** Customer reports a workmanship recurrence within **30 days** (standard services) or **6 months** (`Sipalu Project` renovations) after the 48-hour dispute window has passed.
- **SLA:** QA triage within **4 business hours**; free revisit scheduled within **24 hours**.
- **Procedure:**
  1. **Eligibility Check:** Confirm job was completed & settled **in-app** (anti-leakage policy), within warranty window, and matches original repair scope.
  2. **Free Revisit Dispatch:** Create `Rs 0` warranty work order; dispatch original technician (if rating `>= 4.2`) or escalate to a `Pro/Elite` specialist.
  3. **Fair Technician Compensation:** Platform pays the re-fix technician **hourly** from the warranty reserve pool. If root-cause audit confirms negligent workmanship by the original technician, log a coaching flag and adjust quality metrics.

---

## SOP-07: Anti-Leakage Enforcement, Account Cooldowns & SOS Emergency Safety

- **Trigger:** Automated GPS anomaly, abnormal cancellation spike, failed random selfie, or **SOS Emergency button press**.
- **SLA:** **SOS acknowledged in `< 60 seconds`** (24×7 safety desk); anti-leakage cases reviewed within **24 hours**.
- **Procedure:**
  1. **SOS Emergency Response (Priority 0):**
     - Immediately displays flashing alert on Ops Command Center with live GPS coordinates, customer & technician verified IDs, and booking history.
     - Safety officer bridges immediate ACS voice call to caller within `<60s`; if unreachable or imminent danger is reported, contacts local Nepal Police (`100`) with exact GPS coordinates and stays on line until resolved.
  2. **GPS Anti-Leakage Review:**
     - Automated flag triggers when a technician cancels an accepted job after coming within **`300m`** of the customer pin or shows sustained bid-to-completion drop-off.
     - Ops performs quick courtesy call to homeowner (*"Did your issue get resolved?"*).
     - Confirmed off-platform solicitation penalties: **1st offense:** Formal warning + 72h cooldown; **2nd offense:** 14-day suspension + tier reset; **3rd offense:** Permanent ban & blacklist.
  3. **Cancellation Cooldowns:** Unexcused technician post-accept cancellations trigger progressive ranking penalty + automated cooldown (`24h → 72h → Manual Trust Review`). Customer late cancellations after `En Route` charge call-out fee split `50/50`.

---

## SOP-08: B2B AMC Contract Operations & `<2h` Emergency Response (Phase 2–3)

- **Trigger:** B2B AMC inquiry or commercial client emergency ticket.
- **SLA:** Facility audit `<48h`; Preventive visits scheduled `72h` ahead; **Emergency arrival `< 2 hours`**.
- **Procedure:**
  1. **Onboarding:** Account Manager audits site assets (plumbing, electrical panels, IT/computers, AC units, cleaning areas), defines SLA contract, and loads recurring schedule into AMC Portal.
  2. **Preventive Maintenance:** System auto-dispatches supervisor + crew with digital checklist sign-off and monthly health reports.
  3. **Emergency `<2h` Timer:** Emergency AMC tickets bypass standard bidding, notify Account Manager + standby `Pro/Elite` crew immediately, and display a 120-minute SLA countdown on Ops Command Center.

---

## SOP-09: Turnkey Renovation (`Project`) & Privacy / Grievance Governance

- **Turnkey Renovation (`Sipalu Project`):**
  1. Free site survey within **48 hours** of booking.
  2. Itemized BOQ & schedule (`2–10 weeks`) uploaded within **48 hours** post-survey.
  3. Escrow milestone billing (`30%` mobilization / `40%` mid-stage / `30%` handover) under a single dedicated Project Manager.
  4. Handover sign-off issues digital **6-Month Workmanship Warranty** certificate.
- **Customer Support, Grievance Officer & 7-Day Privacy Deletion:**
  1. Support SLAs: Calls `>= 98%` answered (7am–9pm), Chat `< 2 min`, Email `< 4 hours`.
  2. Unresolved disputes or legal/safety complaints escalate to the designated **Grievance / Complaint Officer** with written update within 24h.
  3. **7-Working-Day PII Deletion:** Verified account-deletion requests trigger the `AnonymizeUserPipeline` Azure Function to scrub all PII & KYC artifacts within **7 working days** while retaining anonymized VAT/financial ledgers as mandated by Nepal tax law.

---

## SOP-10: Azure Cloud SRE, Incident Response, Biometric Vault & Backup/DR

- **Incident Severity SLAs:**
  - **SEV-1 (Booking/Bidding/Escrow/SOS/DB outage):** Ack `<15m`, Mitigate `<45m`, Updates every `30m`.
  - **SEV-2 (Live GPS/WebPubSub degraded, Single payment rail down, Face API timeout):** Ack `<30m`, Mitigate `<2h` (note: if Azure Face API degrades, switch KYC intake to graceful manual-review fallback queue—never block registration).
  - **SEV-3 (Non-critical UI/reporting defect):** Next business day.
- **Core SRE Runbooks:**
  1. **Zero-Downtime Releases:** GitHub Actions → ACR immutable tags → Azure Container Apps blue/green revision split (`10% → 50% → 100%`) with automated rollback if HTTP 5xx `> 1%`.
  2. **Service Bus DLQ Management:** Daily inspection of `booking-events`, `payment-webhooks`, `escrow-commands`, and `payout-commands` DLQs; root-cause fix + idempotent replay (never drop financial messages).
  3. **Biometric & Secret Rotation:** Azure Key Vault rotates DB/Storage/JWT keys every **90 days** via Managed Identity. Audit RBAC access logs on `blob-kyc-vault` weekly.
  4. **Backup & Quarterly DR Game Day:** PostgreSQL 35-day PITR + geo-redundant backup; quarterly restore drill in `South India` validating **RPO `<5 min`** and **RTO `<30 min`**.
  5. **Pilot-to-Scale FinOps:** Azure Cost Budgets at `75% / 90% / 100%`; scale-to-zero enabled for non-prod and batch workers during Phase 1 Banepa/KTM pilot.
