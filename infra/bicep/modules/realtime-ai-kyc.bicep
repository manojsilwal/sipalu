// modules/realtime-ai-kyc.bicep — Web PubSub (Live Bids/GPS/Chat), ACS (Masked VoIP/SOS), Azure AI Vision Face & AI Search

param namePrefix string
param location string
param tags object
param enableScaleTier bool = false

var uniqueSuffix = take(uniqueString(resourceGroup().id, namePrefix), 5)

// Live Bidding Streams, GPS ETA Tracking & In-App Chat
resource webPubSub 'Microsoft.SignalRService/webPubSub@2024-03-01' = {
  name: '${namePrefix}-wps-${uniqueSuffix}'
  location: location
  tags: tags
  sku: {
    name: enableScaleTier ? 'Standard_S1' : 'Free_F1'
    capacity: 1
  }
  properties: {
    tls: { clientCertEnabled: false }
  }
}

// Azure AI Search for Bilingual (EN + Nepali) Symptom Discovery
resource aiSearch 'Microsoft.Search/searchServices@2023-11-01' = {
  name: toLower('${namePrefix}-srch-${uniqueSuffix}')
  location: location
  tags: tags
  sku: {
    name: enableScaleTier ? 'standard' : 'basic'
  }
  properties: {
    replicaCount: enableScaleTier ? 2 : 1
    partitionCount: 1
    semanticSearch: 'standard'
  }
}

// Azure AI Vision Face API for Biometric KYC & Random Selfie Liveness Re-Checks
resource faceApi 'Microsoft.CognitiveServices/accounts@2023-10-01-preview' = {
  name: '${namePrefix}-face-${uniqueSuffix}'
  location: location
  tags: tags
  kind: 'Face'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: '${namePrefix}-face-${uniqueSuffix}'
    disableLocalAuth: false
  }
}

// Azure Communication Services for Masked VoIP/PSTN Calls, SOS Bridge & Transactional Email
resource acs 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: '${namePrefix}-acs-${uniqueSuffix}'
  location: 'global'
  tags: tags
  properties: {
    dataLocation: 'India'
  }
}

// Azure Notification Hubs for Customer & Provider Mobile Push (FCM / APNs)
resource notificationHubNs 'Microsoft.NotificationHubs/namespaces@2023-09-01' = {
  name: '${namePrefix}-nhns-${uniqueSuffix}'
  location: location
  tags: tags
  sku: {
    name: enableScaleTier ? 'Standard' : 'Basic'
  }
}

resource notificationHub 'Microsoft.NotificationHubs/namespaces/notificationHubs@2023-09-01' = {
  parent: notificationHubNs
  name: 'sipalu-mobile-push'
  location: location
}

output webPubSubHostName string = webPubSub.properties.hostName
output aiSearchEndpoint string = 'https://${aiSearch.name}.search.windows.net'
output faceEndpoint string = faceApi.properties.endpoint
output acsName string = acs.name
output notificationHubNamespace string = notificationHubNs.name
