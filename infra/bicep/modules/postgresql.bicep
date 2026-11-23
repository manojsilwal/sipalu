// modules/postgresql.bicep — Azure Database for PostgreSQL Flexible Server + PostGIS + btree_gist

param namePrefix string
param location string
param tags object
param adminLogin string
@secure()
param adminPassword string
param delegatedSubnetId string
param vnetId string
param enableZoneRedundancy bool = false

var uniqueSuffix = take(uniqueString(resourceGroup().id, namePrefix), 5)

resource pgDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${namePrefix}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource pgDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: pgDnsZone
  name: 'vnet-link'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnetId }
    registrationEnabled: false
  }
}

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: '${namePrefix}-pg-${uniqueSuffix}'
  location: location
  tags: tags
  sku: {
    name: enableZoneRedundancy ? 'Standard_D2ds_v5' : 'Standard_B2ms'
    tier: enableZoneRedundancy ? 'GeneralPurpose' : 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: enableZoneRedundancy ? 128 : 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: enableZoneRedundancy ? 35 : 14
      geoRedundantBackup: enableZoneRedundancy ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      mode: enableZoneRedundancy ? 'ZoneRedundant' : 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: pgDnsZone.id
    }
  }
  dependsOn: [pgDnsLink]
}

// Allowlist required extensions: PostGIS (geo/anti-leakage), btree_gist (calendar exclusion), pgcrypto, citext
resource pgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgresServer
  name: 'azure.extensions'
  properties: {
    value: 'POSTGIS,BTREE_GIST,PGCRYPTO,CITEXT'
    source: 'user-override'
  }
}

resource sipaluDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgresServer
  name: 'sipalu'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output fqdn string = postgresServer.properties.fullyQualifiedDomainName
output databaseName string = sipaluDb.name
