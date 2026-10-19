// User-assigned identity for the web app. It signs users in for the app (a federated credential on the Entra app
// registration trusts it, so there's no client secret), or, in client-secret mode, reads that secret from Key Vault.
// Created first so the rest can refer to it without a circular dependency on the web app. Assign it to nothing else:
// whatever holds it can act as the app registration.
param location string
param identityName string

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

output id string = identity.id
output principalId string = identity.properties.principalId
output clientId string = identity.properties.clientId
