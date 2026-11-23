# Sipalu Azure Infrastructure Deployment Guide

This directory contains modular **Azure Bicep** templates supporting both the cost-optimized **Phase 1 Pilot (`pilot-dev`, `pilot-prod`)** and the multi-AZ **Phase 2–3 Nationwide Scale (`scale-prod`)** environments in `Central India`.

## Prerequisites
- Azure CLI (`az >= 2.60`) with Bicep CLI (`az bicep install`)
- Authenticated subscription with `Owner` or `Contributor + User Access Administrator` permissions
- `SIPALU_PG_ADMIN_PASSWORD` exported in your shell or injected from GitHub Actions secrets

## 1. Validate & Preview (`what-if`)
```bash
export SIPALU_PG_ADMIN_PASSWORD='<strong-secret-password>'

az group create \
  --name rg-sipalu-pilot-prod-ci \
  --location centralindia

az deployment group what-if \
  --resource-group rg-sipalu-pilot-prod-ci \
  --template-file infra/bicep/main.bicep \
  --parameters infra/bicep/parameters/pilot-prod.bicepparam
```

## 2. Provision Infrastructure
```bash
az deployment group create \
  --resource-group rg-sipalu-pilot-prod-ci \
  --template-file infra/bicep/main.bicep \
  --parameters infra/bicep/parameters/pilot-prod.bicepparam
```

## 3. Apply PostgreSQL + PostGIS Migrations & Pilot Seeds
Run via a VNet-connected runner / GitHub Actions self-hosted ACA job against the private PostgreSQL FQDN:
```bash
for f in db/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seeds/001_pilot_banepa_kathmandu_seed.sql
```

## 4. Import OpenAPI 3.1 Contract into APIM
```bash
az apim api import \
  --resource-group rg-sipalu-pilot-prod-ci \
  --service-name <apim-name> \
  --path v1 \
  --api-id sipalu-v1 \
  --specification-format OpenApi \
  --specification-path api/openapi.yaml
```
