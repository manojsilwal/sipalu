// modules/networking.bicep — Zero-Trust VNet, Segmented Subnets & NSGs

param namePrefix string
param location string
param tags object

resource nsgAca 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${namePrefix}-nsg-aca'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowHttpsFromVnet'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '443'
        }
      }
    ]
  }
}

resource nsgDataPe 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${namePrefix}-nsg-data-pe'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowAcaToPrivateEndpoints'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: '10.20.2.0/23'
          sourcePortRange: '*'
          destinationAddressPrefix: '10.20.4.0/24'
          destinationPortRanges: ['443', '5432', '6380', '5671']
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${namePrefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: ['10.20.0.0/16']
    }
    subnets: [
      {
        name: 'snet-ingress'
        properties: {
          addressPrefix: '10.20.1.0/24'
        }
      }
      {
        name: 'snet-aca'
        properties: {
          addressPrefix: '10.20.2.0/23'
          networkSecurityGroup: { id: nsgAca.id }
          delegations: [
            {
              name: 'aca-delegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'snet-data-pe'
        properties: {
          addressPrefix: '10.20.4.0/24'
          networkSecurityGroup: { id: nsgDataPe.id }
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'snet-postgres'
        properties: {
          addressPrefix: '10.20.5.0/24'
          delegations: [
            {
              name: 'pg-flexible-delegation'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output ingressSubnetId string = vnet.properties.subnets[0].id
output acaSubnetId string = vnet.properties.subnets[1].id
output privateEndpointsSubnetId string = vnet.properties.subnets[2].id
output postgresSubnetId string = vnet.properties.subnets[3].id
