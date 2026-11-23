// scale-prod.bicepparam — Phase 2-3 Full Valley & Nationwide Multi-AZ Production
using '../main.bicep'

param environment = 'scale-prod'
param location = 'centralindia'
param workloadName = 'sipalu'
param enableZoneRedundancy = true
param pgAdminLogin = 'sipaluadmin'
param pgAdminPassword = readEnvironmentVariable('SIPALU_PG_ADMIN_PASSWORD')
param apimPublisherEmail = 'ops@sipalu.com'
