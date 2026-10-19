# Infrastructure

The Integration World Map runs on **Azure App Service (Linux, B1)**, behind App Service authentication, so only accounts in your Entra ID tenant can open it.
It uses App Service rather than Static Web Apps because Static Web Apps is offered in only a few regions; App Service runs in all of them, so you can keep the site in your own region.
Deployment uses Bicep and two Azure DevOps pipelines:

```
infra/
  stacks/worldmap/deploy-worldmap-stack.bicep          subscription-scope stack
  stacks/worldmap/modules/{identity,keyvault,web-app}  modules used by the stack
  stacks/worldmap/parameters/parameters.worldmap.dev.json
  pipelines/worldmap/worldmap.platform.pipeline.yaml   infrastructure, run by hand
  pipelines/worldmap/worldmap.deploy.pipeline.yaml     data build + site deploy (+ generated wiki page, optional); runs on merge to main
  pipelines/templates/workload.platform.pipeline.template.yaml   reusable platform-pipeline template
```

## What gets created (DEV)

| Resource | Name |
|---|---|
| Resource group (create beforehand) | `rg-contoso-wmap-dev` |
| App Service plan (Linux B1) | `asp-contoso-wmap-dev-01` |
| Web app (Node 24 LTS) | `app-contoso-wmap-dev-01` |
| User-assigned identity (signs users in for the app) | `uai-contoso-wmap-dev-01` |
| Key Vault (only if `signInCredential` is `clientSecret`) | `kv-contoso-wmap-dev-01` |

The names are `{type}-{org}-wmap-{env}-{nn}`. `contoso` is a placeholder: **replace it with your organisation's short name.**
The web app and Key Vault names must be globally unique, and a Key Vault name can be at most 24 characters (`wmap` keeps it short).

The B1 plan is the main cost; the identity is free. Log Analytics and alerts, if you point the stack at them, cost a few dollars a month at this traffic.

## What to change before you start

| Where | What |
|---|---|
| `infra/stacks/worldmap/parameters/parameters.worldmap.dev.json` | `resourceGroupName`, the resource names (replace `contoso`), and `location` (the sample is `australiaeast`; set your own region). `entraClientId` stays empty until step 6. |
| `infra/pipelines/worldmap/worldmap.platform.pipeline.yaml` | `devServiceConnection`, `devSubscriptionId`, `deploymentLocation` |
| `infra/pipelines/worldmap/worldmap.deploy.pipeline.yaml` | `devServiceConnection`, `devWebAppName` (same as `webAppName` in the parameters file), and the `wiki*` variables if you publish the wiki page |

All resource names live in the parameters file, so you can rename them without changing any Bicep.

### Sign-in without a secret

By default (`signInCredential: managedIdentity`) App Service signs users in **as the app registration using the
user-assigned identity**: the app registration has a *federated credential* that trusts the identity, so there's
no client secret to store, rotate or let expire, and no Key Vault. This is Microsoft's documented pattern
([Use a managed identity instead of a secret](https://learn.microsoft.com/azure/app-service/configure-authentication-provider-aad#use-a-managed-identity-instead-of-a-secret)):
the stack sets the app setting `OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID` to the identity's client ID and points the
sign-in configuration at it. Assign the identity to nothing else: whatever holds it can act as the app registration.

`signInCredential: clientSecret` is the fallback: the stack then creates the Key Vault and reads a client secret
from it (step 6b).

## One-time setup, in order

1. **Resource group.** Create the resource group (`rg-contoso-wmap-dev`, renamed) in your subscription and region. The stack expects it to exist already.
2. **Service connection.** In your Azure DevOps project, create an Azure Resource Manager service connection for the subscription, using workload identity federation. Name it to match `devServiceConnection` in both pipelines (`sc-contoso-wmap-dev` in the samples).
   - It needs Contributor on the resource group.
   - It also needs rights to create **subscription-scope deployments** (`az deployment sub create`), for example Contributor on the subscription, or a custom role with `Microsoft.Resources/deployments/*` at subscription scope.
3. **Pipelines.** Register both YAML files in the project:
   - `worldmap-platform` → `infra/pipelines/worldmap/worldmap.platform.pipeline.yaml`
   - `worldmap-deploy` → `infra/pipelines/worldmap/worldmap.deploy.pipeline.yaml`

   The first run asks you to **Permit** access to the `DEV` environment and the service connection.
4. **Wiki page (optional, off by default).** The deploy pipeline can write a generated *World Map Catalogue* page into an Azure DevOps wiki after each deploy. Skip this step if you don't use one: each run still attaches the page as its `wiki-page` artifact. To switch it on:
   1. Set `wikiProject`, `wikiRepository` and `wikiBranch` in `worldmap.deploy.pipeline.yaml` to your wiki's project, Git repo and branch, and set `generatedPage` in `src/config/source.json` to match.
   2. In *Project settings → Repositories → (your wiki repo) → Security*, give the project's **Build Service** account *Contribute* on that repo. The pipeline only ever writes `Integrations/World-Map-Catalogue.md`.
   3. Set `publishWikiPage`'s default to `true` in `worldmap.deploy.pipeline.yaml` (or tick it when running by hand). The next run asks you to **Permit** access to the wiki repo.
5. **First infrastructure run.** Run `worldmap-platform` (DEV).
   - With `entraClientId` empty, the site is created but **refuses all traffic**, so it is never public without sign-in.
   - The run prints the redirect URI and federated credential values for the next step.
6. **Entra app registration.** In your Entra ID tenant, register an app:
   - Single tenant (*Accounts in this organizational directory only*).
   - Platform: **Web**. Redirect URI: `https://<default domain>/.auth/login/aad/callback`, where the default domain is on the web app's *Overview* page (also the platform run's `entraRedirectUri` output). New apps get a unique default domain with a random suffix and region, not `<app name>.azurewebsites.net`, for example `app-contoso-wmap-dev-01-<random>.<region>-01.azurewebsites.net`.
   - Under *Authentication*, tick **ID tokens**. Leave access tokens off.
   - *API permissions*: Microsoft Graph, delegated, `openid`, `profile` and `email` only (remove the default `User.Read`), then **Grant admin consent**. Without admin consent, other users get a consent prompt, or "Need admin approval" if user consent is blocked.
   - Under *Certificates & secrets → Federated credentials → Add credential*, choose the managed identity scenario (or *Other issuer*) with the values from the platform run's `federatedCredential` output:
     - **Issuer:** `https://login.microsoftonline.com/<your tenant ID>/v2.0`
     - **Subject identifier:** the identity's *Object (principal) ID* (`uai-contoso-wmap-dev-01` → Overview → *Principal ID*)
     - **Audience:** `api://AzureADTokenExchange`

     No client secret is needed.
   - **Limit who can open the map (recommended):** in *Enterprise applications* → the app → *Properties*, set **Assignment required** to *Yes*, then assign the group(s) under *Users and groups*. Without this, every account in your tenant can sign in, including B2B guests. (The stack's `allowedGroupObjectIds` does the same check inside App Service, but needs the app registration to send group claims; assignment is simpler.)
7. **Client ID.**
   - Set `entraClientId` to the app's *Application (client) ID* in the parameters file.
   - Run the platform pipeline again. Sign-in is now switched on and traffic is allowed.
   - Sign in at the site to check it. If sign-in fails with `AADSTS70021`, the federated credential's subject doesn't match the identity's principal ID.

   **7b. Only if you chose `signInCredential: clientSecret`:** create a client secret on the app registration (note its expiry), and store it by hand (`keyVaultSecretAdminObjectIds` is empty, so nobody has standing access):
     1. In the portal, open the Key Vault (`kv-contoso-wmap-dev-01`) → *Access policies* → *Create*, and give yourself the secret permissions *Get*, *List* and *Set*.
     2. `az keyvault secret set --vault-name kv-contoso-wmap-dev-01 --name worldmap-entra-client-secret --value <secret>`.
     3. Restart the web app so it picks up the secret.

     The next platform run removes the policy you added (the parameters file holds the whole list). The secret stays. Set a reminder before it expires: when it does, nobody can sign in.
8. **Deploy the site.** Run `worldmap-deploy`. After that it runs by itself whenever `main` changes (for example a merged catalogue PR). Each run checks the data and deploys; if the wiki page is switched on (step 4), it also rewrites that page if its content changed.
   - In *Pipelines → Environments → DEV → Approvals and checks*, add an **Exclusive Lock** check, so two deploys can never run at once.
9. **Monitoring (optional, recommended for production).** Set `logAnalyticsWorkspaceId` to a Log Analytics workspace's resource ID to keep HTTP, console and platform logs there, and `alertActionGroupId` to an action group to be told about server errors (more than 5 in 15 minutes) and a failing health check. Without them, logs stay in App Service (*Log stream*, a week) and nothing alerts.

## Notes

- Deployments sign in through the service connection, so FTP and Kudu basic auth are switched off.
- For a quick manual deploy to DEV without the pipeline, run `src/scripts/deploy-dev.ps1` (or the VS Code task *World Map: deploy to DEV*) after `az login`. It reads the resource group and web app names from the DEV parameters file, builds the data and zip-deploys your working copy, uncommitted changes included. Pass `-Subscription <id>` if the web app isn't in your current Azure CLI subscription.
- The site runs straight from the deployed zip (`WEBSITE_RUN_FROM_PACKAGE`), swapped in one step. To go back, re-run an earlier deploy run's DEV stage (while that run is still kept), or revert the commit on `main`.
- App Service pings `/healthz` (answered by `src/server/server.mjs` without touching the disk) and restarts the app if it stops answering.
- The sign-in token store is off: the app never calls an API on the user's behalf.
- The samples only target DEV. For production, add a parameters file (`parameters.worldmap.prd.json`), a service connection, and a stage in each pipeline, with an approval on the new environment.
- With `clientSecret` sign-in, the Key Vault uses access policies. The parameters file holds the **whole** policy list, and each run replaces any policies added by hand. `keyVaultPurgeProtection` can't be turned off once on.
- The map's data is `src/catalogue/` in this repo; the pipeline doesn't read the wiki. When wiki publishing is on, it checks out the wiki repo only to write the generated page, using a sparse checkout of that one file, so the rest of the wiki never reaches the build agent.
- Security headers, including the Content-Security-Policy, are set in `src/server/server.mjs`.
