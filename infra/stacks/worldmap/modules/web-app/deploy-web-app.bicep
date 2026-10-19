// Linux App Service running server/server.mjs (Node, no dependencies), with App Service authentication ("Easy Auth")
// requiring an Entra ID sign-in. Single-tenant issuer, so only accounts in your tenant can sign in.
param location string
param appServicePlanName string
param appServicePlanSku string
param webAppName string

@description('Resource ID of the user-assigned identity')
param identityId string

@description('Client ID of the user-assigned identity (managed-identity sign-in)')
param identityClientId string

@description('managedIdentity: Easy Auth signs in with the identity (a federated credential on the app registration trusts it). clientSecret: Easy Auth uses a client secret kept in Key Vault.')
@allowed(['managedIdentity', 'clientSecret'])
param signInCredential string

@description('Key Vault that holds the client secret (client-secret mode only)')
param keyVaultName string = ''

@description('Entra app registration client ID; empty means sign-in is not configured yet')
param entraClientId string

param entraClientSecretName string

@description('Object IDs of Entra groups allowed in (empty: any account in your tenant). Needs the app registration to send group claims; requiring assignment on the enterprise app is the simpler way to limit access.')
param allowedGroupObjectIds array = []

@description('Log Analytics workspace resource ID for HTTP, console and platform logs (empty: logs stay in App Service only)')
param logAnalyticsWorkspaceId string = ''

@description('Action group resource ID for alerts on server errors and failed health checks (empty: no alerts)')
param alertActionGroupId string = ''

var signInEnabled = !empty(entraClientId)
var useSecret = signInCredential == 'clientSecret'
// The app setting Easy Auth reads its client credential from: the identity's client ID, or a Key Vault reference.
var credentialSettingName = useSecret ? 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET' : 'OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID'
var credentialSettingValue = useSecret ? '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=${entraClientSecretName})' : identityClientId

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: appServicePlanName
  location: location
  kind: 'linux'
  sku: { name: appServicePlanSku }
  properties: { reserved: true }
}

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    keyVaultReferenceIdentity: identityId
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      appCommandLine: 'node server/server.mjs'
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      // App Service pings this and restarts the app if it stops answering (server.mjs answers without the disk).
      healthCheckPath: '/healthz'
      httpLoggingEnabled: true
      logsDirectorySizeLimit: 35
      // Until sign-in is configured, refuse all traffic rather than serve the map without sign-in.
      ipSecurityRestrictionsDefaultAction: signInEnabled ? 'Allow' : 'Deny'
      appSettings: [
        { name: credentialSettingName, value: credentialSettingValue }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
        // The deploy pipeline runs the site from its zip (swapped in one step). Set here too, because each
        // platform run replaces the whole list of app settings.
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
      ]
    }
  }
}

// Deployments use the pipeline's Entra service connection, so FTP and Kudu basic auth stay off.
resource ftpCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: site
  name: 'ftp'
  properties: { allow: false }
}

resource scmCredentials 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: site
  name: 'scm'
  properties: { allow: false }
}

// Application and HTTP logs, kept a week on the app's file system (Log stream in the portal).
resource logs 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: site
  name: 'logs'
  properties: {
    applicationLogs: { fileSystem: { level: 'Warning' } }
    httpLogs: { fileSystem: { enabled: true, retentionInDays: 7, retentionInMb: 35 } }
    detailedErrorMessages: { enabled: false }
    failedRequestsTracing: { enabled: false }
  }
}

resource auth 'Microsoft.Web/sites/config@2024-04-01' = if (signInEnabled) {
  parent: site
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
          clientId: entraClientId
          clientSecretSettingName: credentialSettingName
        }
        validation: empty(allowedGroupObjectIds) ? {} : {
          defaultAuthorizationPolicy: { allowedPrincipals: { groups: allowedGroupObjectIds } }
        }
      }
    }
    // The app never calls an API on the user's behalf, so it doesn't keep their tokens.
    login: { tokenStore: { enabled: false } }
    httpSettings: { requireHttps: true }
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  scope: site
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [for category in ['AppServiceHTTPLogs', 'AppServiceConsoleLogs', 'AppServiceAppLogs', 'AppServicePlatformLogs']: { category: category, enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

var alerts = [
  { name: 'server-errors', description: 'More than 5 server errors (5xx) in 15 minutes', metric: 'Http5xx', aggregation: 'Total', operator: 'GreaterThan', threshold: 5 }
  { name: 'health-check', description: 'The health check is failing', metric: 'HealthCheckStatus', aggregation: 'Average', operator: 'LessThan', threshold: 100 }
]

resource alertRules 'Microsoft.Insights/metricAlerts@2018-03-01' = [for a in alerts: if (!empty(alertActionGroupId)) {
  name: '${webAppName}-${a.name}'
  location: 'global'
  properties: {
    description: a.description
    severity: 2
    enabled: true
    scopes: [site.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [{ name: a.name, metricName: a.metric, metricNamespace: 'Microsoft.Web/sites', timeAggregation: a.aggregation, operator: a.operator, threshold: a.threshold, criterionType: 'StaticThresholdCriterion' }]
    }
    actions: [{ actionGroupId: alertActionGroupId }]
  }
}]

output hostName string = site.properties.defaultHostName
