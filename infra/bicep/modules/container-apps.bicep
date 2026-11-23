// modules/container-apps.bicep — Azure Container Registry, Managed Identity & VNet-Integrated Container Apps Environment

param namePrefix string
param location string
param tags object
param acaSubnetId string
param logAnalyticsWorkspaceId string
param appInsightsConnectionString string
param keyVaultUri string
param enableZoneRedundancy bool = false

var uniqueSuffix = take(uniqueString(resourceGroup().id, namePrefix), 5)
var acrName = toLower(replace('${take(namePrefix, 15)}acr${uniqueSuffix}', '-', ''))

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: tags
  sku: {
    name: enableZoneRedundancy ? 'Premium' : 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

resource workloadIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-mi-workload'
  location: location
  tags: tags
}

// Grant Workload Identity AcrPull permission on ACR
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, workloadIdentity.id, acrPullRoleId)
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: workloadIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acaEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-cae'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: acaSubnetId
      internal: false
    }
    zoneRedundant: enableZoneRedundancy
    daprAIConnectionString: appInsightsConnectionString
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: reference(logAnalyticsWorkspaceId, '2023-09-01').customerId
        sharedKey: listKeys(logAnalyticsWorkspaceId, '2023-09-01').primarySharedKey
      }
    }
  }
}

// Core Sipalu Microservices Placeholder Definitions (Deploy real images via GitHub Actions CI/CD)
var coreServices = [
  { name: 'kyc-identity-svc', minReplicas: enableZoneRedundancy ? 2 : 0 }
  { name: 'catalog-ranking-svc', minReplicas: enableZoneRedundancy ? 2 : 0 }
  { name: 'booking-bidding-svc', minReplicas: enableZoneRedundancy ? 2 : 1 }
  { name: 'execution-warranty-svc', minReplicas: enableZoneRedundancy ? 2 : 0 }
  { name: 'finance-escrow-svc', minReplicas: enableZoneRedundancy ? 2 : 1 }
  { name: 'safety-antileakage-svc', minReplicas: enableZoneRedundancy ? 2 : 0 }
]

resource microservices 'Microsoft.App/containerApps@2024-03-01' = [
  for svc in coreServices: {
    name: '${namePrefix}-${svc.name}'
    location: location
    tags: tags
    identity: {
      type: 'UserAssigned'
      userAssignedIdentities: {
        '${workloadIdentity.id}': {}
      }
    }
    properties: {
      managedEnvironmentId: acaEnv.id
      configuration: {
        ingress: {
          external: false
          targetPort: 8080
          transport: 'auto'
        }
        dapr: {
          enabled: true
          appId: svc.name
          appPort: 8080
        }
      }
      template: {
        containers: [
          {
            name: svc.name
            image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
            resources: {
              cpu: json('0.5')
              memory: '1Gi'
            }
            env: [
              { name: 'KEY_VAULT_URI', value: keyVaultUri }
              { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            ]
          }
        ]
        scale: {
          minReplicas: svc.minReplicas
          maxReplicas: enableZoneRedundancy ? 10 : 3
        }
      }
    }
  }
]

output defaultDomain string = acaEnv.properties.defaultDomain
output acrLoginServer string = acr.properties.loginServer
output workloadIdentityPrincipalId string = workloadIdentity.properties.principalId
