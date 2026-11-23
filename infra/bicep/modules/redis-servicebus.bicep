// modules/redis-servicebus.bicep — Azure Cache for Redis (Bids/Locks/Geo) & Service Bus (Loop Domain Events)

param namePrefix string
param location string
param tags object
param privateEndpointsSubnetId string
param vnetId string
param enableZoneRedundancy bool = false

var uniqueSuffix = take(uniqueString(resourceGroup().id, namePrefix), 5)

resource redis 'Microsoft.Cache/redis@2024-03-01' = {
  name: '${namePrefix}-redis-${uniqueSuffix}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: enableZoneRedundancy ? 'Premium' : 'Standard'
      family: enableZoneRedundancy ? 'P' : 'C'
      capacity: 1
    }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
  }
}

resource redisDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.redis.cache.windows.net'
  location: 'global'
  tags: tags
}

resource redisDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: redisDnsZone
  name: 'vnet-link'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnetId }
    registrationEnabled: false
  }
}

resource redisPe 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${namePrefix}-pe-redis'
  location: location
  tags: tags
  properties: {
    subnet: { id: privateEndpointsSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'redis-connection'
        properties: {
          privateLinkServiceId: redis.id
          groupIds: ['redisCache']
        }
      }
    ]
  }
}

// Azure Service Bus for Automated Loop Events & Financial Commands
resource serviceBus 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: '${namePrefix}-sb-${uniqueSuffix}'
  location: location
  tags: tags
  sku: {
    name: enableZoneRedundancy ? 'Premium' : 'Standard'
    tier: enableZoneRedundancy ? 'Premium' : 'Standard'
    capacity: enableZoneRedundancy ? 1 : 0
  }
  properties: {
    minimumTlsVersion: '1.2'
    zoneRedundant: enableZoneRedundancy
  }
}

var coreTopics = [
  'booking-events'
  'bidding-events'
  'payment-webhooks'
  'escrow-commands'
  'payout-commands'
  'ranking-events'
  'anti-leakage-sos'
]

resource topics 'Microsoft.ServiceBus/namespaces/topics@2022-10-01-preview' = [
  for topicName in coreTopics: {
    parent: serviceBus
    name: topicName
    properties: {
      defaultMessageTimeToLive: 'P14D'
      enableBatchedOperations: true
      requiresDuplicateDetection: true
      duplicateDetectionHistoryTimeWindow: 'PT10M'
    }
  }
]

output redisHostName string = redis.properties.hostName
output serviceBusNamespace string = serviceBus.name
