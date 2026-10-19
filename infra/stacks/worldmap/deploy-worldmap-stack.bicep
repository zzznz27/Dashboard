// Integration World Map stack: App Service (Linux) behind Entra ID sign-in.
// Subscription scope. The resource group must exist beforehand. Literal names per environment live in
// parameters/parameters.worldmap.<env>.json.
targetScope = 'subscription'

@description('Primary Resource Group name')
param resourceGroupName string

@description('Location for Resources')
param location string

@description('Deployment prefix to identify deployments in Azure Portal')
param deploymentPrefix string = utcNow()

@description('Name of the Workload to be deployed')
param workloadName string = 'worldmap'

param appServicePlanName string

@description('App Service plan SKU. B1 is enough for a static site.')
param appServicePlanSku string = 'B1'

param webAppName string
param userAssignedIdentityName string

@description('How Easy Auth proves it is the app registration. managedIdentity (default): through the identity, via a federated credential on the app registration - nothing to store or rotate. clientSecret: a secret kept in Key Vault.')
@allowed(['managedIdentity', 'clientSecret'])
param signInCredential string = 'managedIdentity'

@description('Key Vault for the client secret (client-secret mode only)')
param keyVaultName string = ''

@description('Object IDs of the people or groups allowed to set the sign-in secret in Key Vault (client-secret mode only)')
param keyVaultSecretAdminObjectIds array = []

@description('Key Vault purge protection (client-secret mode only). Can\'t be turned off once on.')
param keyVaultPurgeProtection bool = false

@description('Application (client) ID of the Entra app registration. Leave empty until it exists: the site then refuses all traffic.')
param entraClientId string = ''

@description('Key Vault secret that holds the Entra app registration client secret (client-secret mode only)')
param entraClientSecretName string = 'worldmap-entra-client-secret'

@description('Object IDs of Entra groups allowed to sign in (empty: any account in your tenant). Needs group claims on the app registration.')
param allowedGroupObjectIds array = []

@description('Log Analytics workspace resource ID for the web app\'s logs (empty: none)')
param logAnalyticsWorkspaceId string = ''

@description('Action group resource ID for alerts (empty: no alerts)')
param alertActionGroupId string = ''

var useSecret = signInCredential == 'clientSecret'

module identity './modules/identity/deploy-identity.bicep' = {
  scope: resourceGroup(resourceGroupName)
  name: '${deploymentPrefix}-${workloadName}-identity'
  params: {
    location: location
    identityName: userAssignedIdentityName
  }
}

module keyVault './modules/keyvault/deploy-keyvault.bicep' = if (useSecret) {
  scope: resourceGroup(resourceGroupName)
  name: '${deploymentPrefix}-${workloadName}-keyvault'
  params: {
    location: location
    keyVaultName: keyVaultName
    secretReaderObjectIds: [identity.outputs.principalId]
    secretAdminObjectIds: keyVaultSecretAdminObjectIds
    purgeProtection: keyVaultPurgeProtection
  }
}

module webApp './modules/web-app/deploy-web-app.bicep' = {
  scope: resourceGroup(resourceGroupName)
  name: '${deploymentPrefix}-${workloadName}-web-app'
  params: {
    location: location
    appServicePlanName: appServicePlanName
    appServicePlanSku: appServicePlanSku
    webAppName: webAppName
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    signInCredential: signInCredential
    keyVaultName: useSecret ? keyVault!.outputs.name : ''
    entraClientId: entraClientId
    entraClientSecretName: entraClientSecretName
    allowedGroupObjectIds: allowedGroupObjectIds
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    alertActionGroupId: alertActionGroupId
  }
}

output webAppUrl string = 'https://${webApp.outputs.hostName}'

@description('Redirect URI to add to the Entra app registration (Web platform)')
output entraRedirectUri string = 'https://${webApp.outputs.hostName}/.auth/login/aad/callback'

output signInEnabled bool = !empty(entraClientId)

@description('Managed-identity sign-in: add a federated credential to the app registration with this issuer, subject and audience api://AzureADTokenExchange')
output federatedCredential object = {
  issuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
  subject: identity.outputs.principalId
  audience: 'api://AzureADTokenExchange'
}
