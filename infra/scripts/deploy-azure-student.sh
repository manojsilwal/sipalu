#!/usr/bin/env bash
set -euo pipefail

# 1-Command Deploy Script for Azure for Students (Free Tier)
# Usage:
#   az login
#   ./infra/scripts/deploy-azure-student.sh [location] [resource-group]

LOCATION="${1:-southeastasia}"
RG_NAME="${2:-rg-sipalu-student}"
IMAGE_TAG="${IMAGE_TAG:-ghcr.io/manojsilwal/sipalu:latest}"

echo "================================================================"
echo " Sipalu — Azure for Students Free-Tier Deployment"
echo " Region: $LOCATION | Resource Group: $RG_NAME"
echo " Image : $IMAGE_TAG"
echo "================================================================"

if ! command -v az >/dev/null 2>&1; then
  echo "ERROR: Azure CLI (az) is not installed. Install from https://learn.microsoft.com/cli/azure/install-azure-cli"
  exit 1
fi

az account show >/dev/null 2>&1 || { echo "Please run 'az login' first."; exit 1; }

# Generate strong secrets automatically if not provided via env
PG_PASS="${SIPALU_PG_ADMIN_PASSWORD:-SipaluPg!$(openssl rand -hex 8)}"
JWT_SEC="${SIPALU_JWT_SECRET:-$(openssl rand -hex 32)}"

echo "1) Registering required Azure resource providers (first-time Student accounts)..."
az provider register --namespace Microsoft.App --wait >/dev/null 2>&1 || true
az provider register --namespace Microsoft.DBforPostgreSQL --wait >/dev/null 2>&1 || true
az provider register --namespace Microsoft.OperationalInsights --wait >/dev/null 2>&1 || true

echo "2) Creating Resource Group '$RG_NAME' in '$LOCATION'..."
az group create --name "$RG_NAME" --location "$LOCATION" --output none

echo "3) Deploying PostgreSQL B1ms (12m Free) + Container Apps (Free Consumption)..."
DEPLOY_OUT=$(az deployment group create \
  --resource-group "$RG_NAME" \
  --template-file infra/bicep/student-free.bicep \
  --parameters \
    location="$LOCATION" \
    containerImage="$IMAGE_TAG" \
    pgAdminPassword="$PG_PASS" \
    jwtSecret="$JWT_SEC" \
    esewaProductCode="${ESEWA_PRODUCT_CODE:-EPAYTEST}" \
    esewaSecretKey="${ESEWA_SECRET_KEY:-8gBm/:&EnhH.1/q}" \
    khaltiSecretKey="${KHALTI_SECRET_KEY:-}" \
    fonepaySecretKey="${FONEPAY_SECRET_KEY:-}" \
  --query "properties.outputs" \
  --output json)

APP_URL=$(echo "$DEPLOY_OUT" | grep -o '"appUrl":[^}]*' | head -n1 | sed 's/.*"value": "\([^"]*\)".*/\1/')

echo "================================================================"
echo " DEPLOYMENT COMPLETE!"
echo " Live Sipalu URL: $APP_URL"
echo " Sipalu Test Accounts (Password: Sipalu@2026):"
echo "   manoj (Founder/Admin) | sipalu_customer | sipalu_expert"
echo "   aarav | bikram | raju | sita | admin"
echo " Sandbox Gateways Active: eSewa UAT, Khalti Sandbox, Fonepay UAT"
echo "================================================================"
