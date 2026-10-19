// Key Vault for the Entra sign-in secret, used only when the stack runs in client-secret mode (signInCredential).
// Access policies (not RBAC). The policies here are the full list: each deployment replaces
// any added by hand.
param location string
param keyVaultName string

@description('Object IDs that may read secrets (the web app identity)')
param secretReaderObjectIds array

@description('Object IDs that may manage secrets (people or groups)')
param secretAdminObjectIds array = []

@description('Purge protection: a deleted vault or secret can\'t be purged before its 90 days are up. Can\'t be turned off once on.')
param purgeProtection bool = false

var readers = [for id in secretReaderObjectIds: {
  tenantId: tenant().tenantId
  objectId: id
  permissions: { secrets: ['get', 'list'] }
}]
var admins = [for id in secretAdminObjectIds: {
  tenantId: tenant().tenantId
  objectId: id
  permissions: { secrets: ['get', 'list', 'set', 'delete'] }
}]

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: false
    enableSoftDelete: true
    // The API rejects false here, so leave the property out unless it's being switched on.
    enablePurgeProtection: purgeProtection ? true : null
    accessPolicies: concat(readers, admins)
    publicNetworkAccess: 'Enabled'
  }
}

output name string = keyVault.name
