# 07 — Azure for Students Free Deployment & Nepal Payment Gateways Guide (eSewa, Khalti, Fonepay)

This guide walks you step-by-step through:
1. Publishing **Sipalu** live to your **Azure for Students (Free Tier)** account in ~5 minutes (`$0/mo` inside free grants + `$100` credit).
2. Configuring **Azure Secrets** cleanly without exposing keys in code.
3. Integrating live & sandbox **eSewa ePay v2**, **Khalti ePayment v2**, and **Fonepay Dynamic QR / PRN**.

---

## Part 1: Publish to Azure for Students (Free Tier)

### Cost Architecture (`infra/bicep/student-free.bicep`)
| Resource | Tier | Azure for Students Cost |
|---|---|---|
| **Azure Database for PostgreSQL Flexible Server** | `Standard_B1ms` (32 GB, PostgreSQL 16 + PostGIS + `btree_gist`) | **$0/mo** (12 months free grant: 750 hrs/mo + 32 GB) |
| **Azure Container Apps** | Consumption Plan (`0.5 vCPU`, `1 GiB`, Scale-to-Zero, HTTPS + `/ws` WebSockets) | **$0/mo** (Free grant: 180k vCPU-s, 360k GiB-s, 2M reqs/mo) |
| **Container Registry** | GitHub Container Registry (`ghcr.io/manojsilwal/sipalu:latest`) | **$0/mo** (Free for public repos) |
| **Log Analytics Workspace** | Pay-as-you-go (30-day retention) | **$0/mo** (First 5 GB/mo free) |

> **Azure for Students Region Tip:** Some Azure for Students subscriptions restrict specific regions (like `centralindia` or `eastus`). If a deployment returns `RequestDisallowedByAzure`, pass `southeastasia`, `eastasia`, or `eastus2` — `southeastasia` (Singapore) has great latency to Nepal (`~65–80ms`).

### Option A: 1-Command Deploy from Your Terminal (Fastest — 5 Minutes)
1. **Make your GHCR package public** (once GitHub Actions finishes building `ghcr.io/manojsilwal/sipalu:latest` after push to `main`):
   - Open `https://github.com/manojsilwal?tab=packages` → click `sipalu` → **Package settings** → **Change visibility → Public**.
2. **Sign in to Azure for Students & deploy:**
   ```bash
   az login
   chmod +x infra/scripts/deploy-azure-student.sh
   ./infra/scripts/deploy-azure-student.sh southeastasia rg-sipalu-student
   ```
3. On first boot, `AUTO_MIGRATE=true` automatically creates all PostGIS extensions, runs `001`–`006` SQL migrations, seeds Banepa & Kathmandu Valley SKUs, and creates your demo login accounts (`aarav`, `bikram`, `raju`, `sita`, `admin` — Password: **`Sipalu@2026`**).

### Option B: Automatic GitHub Actions Deploy on Every Push to `main`
1. Create an Azure Service Principal scoped to your resource group:
   ```bash
   az group create --name rg-sipalu-student --location southeastasia
   SUB_ID=$(az account show --query id -o tsv)
   az ad sp create-for-rbac \
     --name "sp-sipalu-github-deploy" \
     --role contributor \
     --scopes "/subscriptions/$SUB_ID/resourceGroups/rg-sipalu-student" \
     --sdk-auth
   ```
2. Copy the printed JSON and add these **GitHub Repository Secrets** (`Settings → Secrets and variables → Actions`):
   - `AZURE_CREDENTIALS` — The full JSON from step 1.
   - `SIPALU_PG_ADMIN_PASSWORD` — Strong 16+ char DB password (e.g., `SipaluDb#2026!Secure`).
   - `SIPALU_JWT_SECRET` — Output of `openssl rand -hex 32`.
   - *(Optional payment secrets below)*: `ESEWA_PRODUCT_CODE`, `ESEWA_SECRET_KEY`, `KHALTI_SECRET_KEY`, `FONEPAY_SECRET_KEY`.
3. Trigger **Actions → Build & Publish Sipalu Container + Deploy to Azure for Students → Run workflow**.

---

## Part 2: Step-by-Step Nepal Payment Gateway Integration

Sipalu's backend (`services/api/src/routes/paymentGateways.ts`) already ships with production-ready cryptographic adapters for all three Nepal rails. Check active configuration anytime at `GET /v1/payments/gateways/status`.

### 1. eSewa ePay v2 (HMAC-SHA256)
**Sandbox Testing (Works Out-of-the-Box!):**
- Endpoint: `https://rc-epay.esewa.com.np/api/epay/main/v2/form`
- Default Sandbox `ESEWA_PRODUCT_CODE`: `EPAYTEST`
- Default Sandbox `ESEWA_SECRET_KEY`: `8gBm/:&EnhH.1/q`
- Official eSewa Test Wallet: ID `9806800001`, Password `Nepal@123`, MPIN `1122`, OTP `987654`.

**Going Live on Production:**
1. Register as a merchant at `https://merchant.esewa.com.np/` with your Company Registration (OCR), PAN/VAT certificate, and corporate bank account.
2. Receive your live `ESEWA_PRODUCT_CODE` and `ESEWA_SECRET_KEY`.
3. Update Azure Container Apps secrets:
   ```bash
   az containerapp secret set -n sipalu-student-app -g rg-sipalu-student \
     --secrets esewa-secret-key="<LIVE_ESEWA_SECRET>"
   az containerapp update -n sipalu-student-app -g rg-sipalu-student \
     --set-env-vars ESEWA_PRODUCT_CODE="<LIVE_PRODUCT_CODE>" \
                    ESEWA_EPAY_URL="https://epay.esewa.com.np/api/epay/main/v2/form"
   ```
4. **Checkout Flow:** Frontend calls `POST /v1/payments/gateways/esewa/sign` → auto-submits returned `form_fields` to `action_url` → eSewa redirects to `success_url?data=<base64>` → Frontend posts `data` to `POST /v1/payments/webhooks/esewa` which verifies HMAC-SHA256 signature and posts to the double-entry ledger.

---

### 2. Khalti ePayment v2 (Server-to-Server API)
**Sandbox Testing:**
1. Create a free developer merchant account at `https://test-admin.khalti.com/`.
2. Copy your **Live Secret Key** (sandbox starts with `test_secret_key_...`) from `Settings → Keys`.
3. Set it in Azure Container Apps:
   ```bash
   az containerapp secret set -n sipalu-student-app -g rg-sipalu-student \
     --secrets khalti-secret-key="<YOUR_KHALTI_SECRET_KEY>"
   az containerapp update -n sipalu-student-app -g rg-sipalu-student \
     --set-env-vars KHALTI_API_BASE="https://a.khalti.com/api/v2"
   ```
4. Test with Khalti Sandbox Wallet (`9800000000`, MPIN `1111`, OTP `987654`).

**Going Live on Production:**
1. Complete KYC & merchant agreement at `https://admin.khalti.com/` (submit OCR, PAN/VAT, Board Resolution, Bank Letter).
2. Switch `KHALTI_API_BASE` to `https://khalti.com/api/v2` and set your production `khalti-secret-key`.
3. **Checkout Flow:** Frontend calls `POST /v1/payments/gateways/khalti/initiate` (amount auto-converted to **paisa** `NPR × 100`) → redirects user to returned `payment_url` → upon callback with `pidx`, backend calls Khalti `/epayment/lookup/` server-to-server before crediting the double-entry ledger.

---

### 3. Fonepay Dynamic QR / Merchant PRN (HMAC-SHA512)
**Merchant Onboarding & Integration:**
1. Apply for Fonepay Merchant / Dynamic QR API access through your corporate acquiring bank in Nepal (e.g., **Nabil, NMB, NIC Asia, Global IME, Siddhartha**) or via `https://fonepay.com/merchant`.
2. Request **PG / Dynamic QR API credentials**: `PID` (Merchant Code), `Secret Key` (for HMAC-SHA512 `DV` digest), and UAT vs Live base URLs.
3. Configure in Azure Container Apps:
   ```bash
   az containerapp secret set -n sipalu-student-app -g rg-sipalu-student \
     --secrets fonepay-secret-key="<YOUR_FONEPAY_SECRET>"
   az containerapp update -n sipalu-student-app -g rg-sipalu-student \
     --set-env-vars FONEPAY_PID="<YOUR_PID>" \
                    FONEPAY_URL="https://clientapi.fonepay.com/api/merchantRequest"
   ```
4. **Checkout Flow:** Frontend calls `POST /v1/payments/gateways/fonepay/sign` → redirects or renders Dynamic QR with signed `DV` digest → backend validates callback `DV` HMAC-SHA512 before marking `payment_transactions` as `CAPTURED`.

---

## Part 3: Updating Live Azure Secrets Anytime (Zero Downtime)
```bash
# Rotate JWT Secret or Payment Keys on Azure Container Apps
az containerapp secret set \
  --name sipalu-student-app \
  --resource-group rg-sipalu-student \
  --secrets jwt-secret="$(openssl rand -hex 32)"
```
