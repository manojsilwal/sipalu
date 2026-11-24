// infra/bicep/student-free.bicep
// Ultra-lean Azure for Students Free-Tier Deployment ($0-$5/mo inside Student Free Grants + $100 Credit)
// Components:
//   - Azure PostgreSQL Flexible Server Standard_B1ms (12 months FREE for Students: 750h/mo + 32GB)
//   - Azure Container Apps Consumption Plan (FREE monthly grant: 180k vCPU-s, 360k GiB-s, 2M reqs)
//   - Built-in HTTPS TLS + WebSockets (/ws) + Scale-to-Zero + Secrets for eSewa/Khalti/Fonepay

targetScope = 'resourceGroup'

@description('Azure region allowed by your Azure for Students policy (e.g. centralindia, southeastasia, eastasia, eastus2)')
param location string = 'centralindia'

@description('Unique app prefix')
param appName string = 'sipalu-student'

@description('Container image URL (defaults to free GitHub Container Registry)')
param containerImage string = 'ghcr.io/manojsilwal/sipalu:latest'

@description('PostgreSQL administrator login')
param pgAdminLogin string = 'sipaluadmin'

@secure()
@description('PostgreSQL administrator password (min 12 chars with upper/lower/digit/symbol)')
param pgAdminPassword string

@secure()
@description('JWT signing secret (min 32 random chars)')
param jwtSecret string

@secure()
@description('Optional eSewa v2 Secret Key (defaults to eSewa UAT sandbox if empty)')
param esewaSecretKey string = '8gBm/:&EnhH.1/q'

@description('eSewa Product Code (EPAYTEST for sandbox, or your live Merchant Code)')
param esewaProductCode string = 'EPAYTEST'

@secure()
@description('Optional Khalti ePayment v2 Secret Key')
param khaltiSecretKey string = ''

@secure()
@description('Optional Fonepay Secret Key')
param fonepaySecretKey string = ''

var uniqueSuffix = take(uniqueString(resourceGroup().id, appName), 5)
var pgServerName = toLower('${appName}-pg-${uniqueSuffix}')

// 1. Log Analytics (Free 5GB/month ingestion)
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-law-${uniqueSuffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// 2. Azure Database for PostgreSQL Flexible Server — B1ms (12 Months Free for Students)
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: pgServerName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: pgAdminLogin
    administratorLoginPassword: pgAdminPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource pgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'POSTGIS,BTREE_GIST,PGCRYPTO,CITEXT'
    source: 'user-override'
  }
}

resource sipaluDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgres
  name: 'sipalu'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// 3. Azure Container Apps Environment (Consumption Free Grant)
resource acaEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${appName}-cae-${uniqueSuffix}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

var databaseUrl = 'postgresql://${pgAdminLogin}:${pgAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/sipalu?sslmode=require'

// 4. Unified Sipalu Container App (Web + API + /ws WebSockets + Auto-Migrate)
resource sipaluApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${appName}-app'
  location: location
  dependsOn: [pgAllowAzure, pgExtensions, sipaluDb]
  properties: {
    managedEnvironmentId: acaEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        { name: 'database-url', value: databaseUrl }
        { name: 'jwt-secret', value: jwtSecret }
        { name: 'esewa-secret-key', value: esewaSecretKey }
        { name: 'khalti-secret-key', value: empty(khaltiSecretKey) ? 'unset' : khaltiSecretKey }
        { name: 'fonepay-secret-key', value: empty(fonepaySecretKey) ? 'unset' : fonepaySecretKey }
      ]
    }
    template: {
      containers: [
        {
          name: 'sipalu'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'AUTO_MIGRATE', value: 'true' }
            { name: 'PGSSLMODE', value: 'require' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
            { name: 'ESEWA_PRODUCT_CODE', value: esewaProductCode }
            { name: 'ESEWA_SECRET_KEY', secretRef: 'esewa-secret-key' }
            { name: 'KHALTI_SECRET_KEY', secretRef: 'khalti-secret-key' }
            { name: 'FONEPAY_SECRET_KEY', secretRef: 'fonepay-secret-key' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 15
              periodSeconds: 30
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

output appUrl string = 'https://${sipaluApp.properties.configuration.ingress.fqdn}'
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
