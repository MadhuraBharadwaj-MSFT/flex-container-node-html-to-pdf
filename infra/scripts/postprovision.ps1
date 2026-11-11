$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $repositoryRoot

function Get-AzdValue {
    param([Parameter(Mandatory)][string]$Name)

    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = (& azd env get-value $Name).Trim()
    }
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Required azd environment value '$Name' is missing."
    }
    return $value
}

function Invoke-WithRetry {
    param(
        [Parameter(Mandatory)][scriptblock]$Operation,
        [int]$Attempts = 6,
        [int]$DelaySeconds = 10
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            return & $Operation
        } catch {
            if ($attempt -eq $Attempts) {
                throw
            }
            Start-Sleep -Seconds $DelaySeconds
        }
    }
}

$parameterPath = $null
$buildContext = $null
$registryPassword = $null

try {
    $subscriptionId = Get-AzdValue 'AZURE_SUBSCRIPTION_ID'
    $environmentName = Get-AzdValue 'AZURE_ENV_NAME'
    $resourceGroup = Get-AzdValue 'AZURE_RESOURCE_GROUP'
    $registryName = Get-AzdValue 'AZURE_CONTAINER_REGISTRY_NAME'
    $registryEndpoint = Get-AzdValue 'AZURE_CONTAINER_REGISTRY_ENDPOINT'
    $imageRepository = Get-AzdValue 'AZURE_IMAGE_REPOSITORY'
    $tokenName = Get-AzdValue 'AZURE_ACR_TOKEN_NAME'
    $functionAppName = Get-AzdValue 'AZURE_FUNCTION_NAME'
    $functionLocation = Get-AzdValue 'AZURE_FUNCTION_LOCATION'
    $appServicePlanId = Get-AzdValue 'AZURE_APP_SERVICE_PLAN_ID'
    $storageAccountName = Get-AzdValue 'AZURE_STORAGE_ACCOUNT_NAME'
    $applicationInsightsConnectionString =
        Get-AzdValue 'AZURE_APPLICATION_INSIGHTS_CONNECTION_STRING'

    & az account set --subscription $subscriptionId

    $gitRevision = (& git rev-parse --short=12 HEAD).Trim()
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
    $imageTag = "azd-$gitRevision-$timestamp"
    $taggedImage = "$imageRepository`:$imageTag"

    $buildContext = Join-Path ([IO.Path]::GetTempPath()) (
        "function-image-$([guid]::NewGuid().ToString('N'))"
    )
    New-Item -ItemType Directory -Path $buildContext | Out-Null
    foreach ($file in @(
            '.dockerignore',
            'host.json',
            'node24.Dockerfile',
            'package-lock.json',
            'package.json',
            'tsconfig.json'
        )) {
        Copy-Item -LiteralPath (Join-Path $repositoryRoot $file) `
            -Destination (Join-Path $buildContext $file)
    }
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'src') `
        -Destination (Join-Path $buildContext 'src') `
        -Recurse
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'vendor') `
        -Destination (Join-Path $buildContext 'vendor') `
        -Recurse

    Write-Host "Building Linux AMD64 image $registryEndpoint/$taggedImage"
    & az acr login `
        --name $registryName `
        --resource-group $resourceGroup `
        --only-show-errors
    & docker buildx build `
        --platform linux/amd64 `
        --file (Join-Path $buildContext 'node24.Dockerfile') `
        --tag "$registryEndpoint/$taggedImage" `
        --push `
        --provenance=false `
        $buildContext

    $digest = Invoke-WithRetry {
        $value = (& az acr manifest show-metadata `
                --registry $registryName `
                --name $taggedImage `
                --query digest `
                --output tsv `
                --only-show-errors).Trim()
        if ($value -notmatch '^sha256:[0-9a-f]{64}$') {
            throw "Image digest is not available yet."
        }
        return $value
    }
    $registryImage = "$registryEndpoint/$taggedImage@$digest"

    $registryPassword = Invoke-WithRetry {
        $value = (& az acr token credential generate `
                --registry $registryName `
                --resource-group $resourceGroup `
                --name $tokenName `
                --password1 `
                --expiration-in-days 30 `
                --query "passwords[?name=='password1'].value | [0]" `
                --output tsv `
                --only-show-errors).Trim()
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "ACR token password generation returned no value."
        }
        return $value
    }
    $storageConnectionString = (& az storage account show-connection-string `
            --resource-group $resourceGroup `
            --name $storageAccountName `
            --query connectionString `
            --output tsv `
            --only-show-errors).Trim()
    if ([string]::IsNullOrWhiteSpace($storageConnectionString)) {
        throw 'Storage connection-string retrieval returned no value.'
    }

    $parameters = @{
        '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters = @{
            environmentName = @{ value = $environmentName }
            functionAppName = @{ value = $functionAppName }
            functionLocation = @{ value = $functionLocation }
            appServicePlanId = @{ value = $appServicePlanId }
            applicationInsightsConnectionString = @{
                value = $applicationInsightsConnectionString
            }
            storageConnectionString = @{ value = $storageConnectionString }
            registryImage = @{ value = $registryImage }
            registryUsername = @{ value = $tokenName }
            registryPassword = @{ value = $registryPassword }
        }
    }

    $parameterPath = Join-Path ([IO.Path]::GetTempPath()) (
        "function-app-$([guid]::NewGuid().ToString('N')).parameters.json"
    )
    $parameters |
        ConvertTo-Json -Depth 10 |
        Set-Content -LiteralPath $parameterPath -Encoding utf8NoBOM

    $deploymentName = "registry-app-$timestamp"
    $state = (& az deployment group create `
            --resource-group $resourceGroup `
            --name $deploymentName `
            --template-file .\infra\app\api.bicep `
            --parameters "@$parameterPath" `
            --query properties.provisioningState `
            --output tsv `
            --only-show-errors).Trim()
    if ($state -ne 'Succeeded') {
        throw "Registry Function App deployment ended in state '$state'."
    }

    & azd env set AZURE_IMAGE_TAG $imageTag --no-prompt | Out-Null
    & azd env set AZURE_IMAGE_DIGEST $digest --no-prompt | Out-Null
    & azd env set AZURE_REGISTRY_IMAGE $registryImage --no-prompt | Out-Null
    & azd env set API_URL "https://$functionAppName.azurewebsites.net" --no-prompt |
        Out-Null

    & az functionapp restart `
        --resource-group $resourceGroup `
        --name $functionAppName `
        --only-show-errors

    Write-Host "Created Registry-backed Function App '$functionAppName'."
    Write-Host "Pinned image: $registryImage"
} finally {
    if ($parameterPath -and (Test-Path -LiteralPath $parameterPath)) {
        Remove-Item -LiteralPath $parameterPath -Force
    }
    if ($buildContext -and (Test-Path -LiteralPath $buildContext)) {
        Remove-Item -LiteralPath $buildContext -Recurse -Force
    }
    $registryPassword = $null
    $storageConnectionString = $null
    Pop-Location
}
