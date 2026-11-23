// main.bicep — Sipalu Unified Azure Cloud Platform Orchestrator
// Supports Phase 1 Pilot (Banepa + KTM Valley) and Phase 2-3 Scale via parameter profiles

targetScope = 'resourceGroup'

@description('Deployment environment name')
@allowed(['pilot-dev', 'pilot-prod', 'scale-prod'])
param environment string = 'pilot-dev'

@description('Primary Azure region (Central India gives lowest latency to Nepal ~30-45ms)')
param location string = 'centralindia'

@description('Workload prefix used in naming conventions')
param workloadName string = 'sipalu'

@description('Enable zone-redundant HA & Premium edge SKUs (true for scale-prod)')
param enableZoneRedundancy bool = false

@description('PostgreSQL administrator login')
param pgAdminLogin string = 'sipaluadmin'

@secure()
@description('PostgreSQL administrator password (inject from Azure Key Vault / CI secret)')
param pgAdminPassword string

@description('Publisher email for Azure API Management')
param apimPublisherEmail string = 'platform@sipalu.com'

var namePrefix = '${workloadName}-${environment}'
var commonTags = {
  workload: workloadName
  environment: environment
  managedBy: 'bicep'
  architecture: 'sipalu-unified-v2'
}

module networking './modules/networking.bicep' = {
  name: 'deploy-networking'
  params: {
    namePrefix: namePrefix
    location: location
    tags: commonTags
  }
}

module securityObs './modules/security-observability.bicep' = {
  name: 'deploy-security-observability'
  params: {
    namePrefix: namePrefix
    location: location
    tags: commonTags
    privateEndpointsSubnetId: networking.outputs.privateEndpointsSubnetId
    vnetId: networking.outputs.vnetId
    enableGeoRedundancy: enableZoneRedundancy
  }
}

module postgresql './modules/postgresql.bicep' = {
  name: 'deploy-postgresql'
  params: {
    namePrefix: namePrefix
    location: location
    tags: commonTags
    adminLogin: pgAdminLogin
    adminPassword: pgAdminPassword
    delegatedSubnetId: networking.outputs.postgresSubnetId
    vnetId: networking.outputs.vnetId
    enableZoneRedundancy: enableZoneRedundancy
  }
}

module redisServiceBus './modules/redis-servicebus.bicep' = {
  name: 'deploy-redis-servicebus'
  params: {
    namePrefix: namePrefix
    location: location
    tags: commonTags
    privateEndpointsSubnetId: networking.outputs.privateEndpointsSubnetId
    vnetId: networking.outputs.vnetId
    enableZoneRedundancy: enableZoneRedundancy
  }
}

module realtimeAiKyc './modules/realtime-ai-kyc.bicep' = {
  name: 'deploy-realtime-ai-kyc'
  params: {
    namePrefix: namePrefix
    location: location
    tags: commonTags
    enableScaleTier: enableZoneRedundancy
  }
}

module containerApps './modules/container-apps.bicep' = {
  name: 'deploy-container-apps'
  params: {
    namePrefix: namePrefix
    location: location
    tags: commonTags
    acaSubnetId: networking.outputs.acaSubnetId
    logAnalyticsWorkspaceId: securityObs.outputs.logAnalyticsWorkspaceId
    appInsightsConnectionString: securityObs.outputs.appInsightsConnectionString
    keyVaultUri: securityObs.outputs.keyVaultUri
    enableZoneRedundancy: enableZoneRedundancy
  }
}

module edgeApim './modules/edge-apim.bicep' = {
  name: 'deploy-edge-apim'
  params: {
    namePrefix: namePrefix
    location: location
    tags: commonTags
    publisherEmail: apimPublisherEmail
    enablePremiumEdge: enableZoneRedundancy
  }
}

output vnetId string = networking.outputs.vnetId
output keyVaultName string = securityObs.outputs.keyVaultName
output storageAccountName string = securityObs.outputs.storageAccountName
output postgresFqdn string = postgresql.outputs.fqdn
output redisHostName string = redisServiceBus.outputs.redisHostName
output serviceBusNamespace string = redisServiceBus.outputs.serviceBusNamespace
output webPubSubHostName string = realtimeAiKyc.outputs.webPubSubHostName
output aiSearchEndpoint string = realtimeAiKyc.outputs.aiSearchEndpoint
output faceEndpoint string = realtimeAiKyc.outputs.faceEndpoint
output acaEnvironmentDefaultDomain string = containerApps.outputs.defaultDomain
output acrLoginServer string = containerApps.outputs.acrLoginServer
output frontDoorEndpointHostName string = edgeApim.outputs.frontDoorHostName
output apimGatewayUrl string = edgeApim.outputs.apimGatewayUrl
