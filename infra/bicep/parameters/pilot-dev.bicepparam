// pilot-dev.bicepparam — Phase 1 Development Environment (Banepa & Kathmandu Pilot)
using '../main.bicep'

param environment = 'pilot-dev'
param location = 'centralindia'
param workloadName = 'sipalu'
param enableZoneRedundancy = false
param pgAdminLogin = 'sipaluadmin'
param pgAdminPassword = readEnvironmentVariable('SIPALU_PG_ADMIN_PASSWORD')
param apimPublisherEmail = 'dev-platform@sipalu.com'
