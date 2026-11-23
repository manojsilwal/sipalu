// modules/edge-apim.bicep — Azure Front Door + OWASP WAF + Azure API Management

param namePrefix string
param location string
param tags object
param publisherEmail string
param enablePremiumEdge bool = false

var uniqueSuffix = take(uniqueString(resourceGroup().id, namePrefix), 5)

resource apim 'Microsoft.ApiManagement/service@2023-09-01-preview' = {
  name: '${namePrefix}-apim-${uniqueSuffix}'
  location: location
  tags: tags
  sku: {
    name: enablePremiumEdge ? 'StandardV2' : 'BasicV2'
    capacity: 1
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: 'Sipalu Platform'
  }
}

resource frontDoorProfile 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: '${namePrefix}-afd-${uniqueSuffix}'
  location: 'global'
  tags: tags
  sku: {
    name: enablePremiumEdge ? 'Premium_AzureFrontDoor' : 'Standard_AzureFrontDoor'
  }
}

resource afdEndpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: frontDoorProfile
  name: '${namePrefix}-edge-${uniqueSuffix}'
  location: 'global'
  properties: {
    enabledState: 'Enabled'
  }
}

resource wafPolicy 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2024-02-01' = {
  name: replace('${namePrefix}waf${uniqueSuffix}', '-', '')
  location: 'global'
  tags: tags
  sku: {
    name: enablePremiumEdge ? 'Premium_AzureFrontDoor' : 'Standard_AzureFrontDoor'
  }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: 'Prevention'
      requestBodyCheck: 'Enabled'
    }
    customRules: {
      rules: [
        {
          name: 'RateLimitOtpAndAuth'
          priority: 100
          ruleType: 'RateLimitRule'
          rateLimitDurationInMinutes: 1
          rateLimitThreshold: 20
          action: 'Block'
          matchConditions: [
            {
              matchVariable: 'RequestUri'
              operator: 'Contains'
              matchValue: ['/auth/otp/']
            }
          ]
        }
      ]
    }
  }
}

output frontDoorHostName string = afdEndpoint.properties.hostName
output apimGatewayUrl string = apim.properties.gatewayUrl
