// pilot-prod.bicepparam — Phase 1 Production Pilot (Banepa & Select Kathmandu Valley Wards)
using '../main.bicep'

param environment = 'pilot-prod'
param location = 'centralindia'
param workloadName = 'sipalu'
param enableZoneRedundancy = false
param pgAdminLogin = 'sipaluadmin'
param pgAdminPassword = readEnvironmentVariable('SIPALU_PG_ADMIN_PASSWORD')
param apimPublisherEmail = 'ops@sipalu.com'
