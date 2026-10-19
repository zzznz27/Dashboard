# Deploys this working copy to the DEV web app. Run `az login` first.
# The deploy pipeline (worldmap-deploy) is still the normal route; this is for a quick manual deploy.
# The resource group and web app names come from the DEV parameters file, so there's only one place to change them.

param(
  # Subscription that holds the web app. Empty: the Azure CLI's current subscription (az account show).
  [string]$Subscription = ''
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

$parameters    = (Get-Content infra/stacks/worldmap/parameters/parameters.worldmap.dev.json -Raw | ConvertFrom-Json).parameters
$resourceGroup = $parameters.resourceGroupName.value
$webApp        = $parameters.webAppName.value
$subscriptionArgs = if ($Subscription) { @('--subscription', $Subscription) } else { @() }

# Build the map data from src/catalogue/
node src/scripts/build-data.mjs
if ($LASTEXITCODE) { throw 'The data build failed; nothing was deployed.' }

# Package src/web and src/server, as the pipeline does (maintainer .md notes left out)
Remove-Item out/site, out/worldmap-site.zip -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory out/site | Out-Null
Copy-Item src/web, src/server out/site -Recurse
Get-ChildItem out/site -Recurse -Filter *.md | Remove-Item
Compress-Archive out/site/* out/worldmap-site.zip

# Deploy
Write-Host "Deploying to $webApp in $resourceGroup"
az webapp deploy @subscriptionArgs --resource-group $resourceGroup --name $webApp `
  --src-path out/worldmap-site.zip --type zip
if ($LASTEXITCODE) { throw 'The deploy failed.' }
