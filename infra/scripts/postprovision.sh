#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPOSITORY_ROOT"

get_azd_value() {
    name=$1
    eval "value=\${$name:-}"
    if [ -z "$value" ]; then
        value=$(azd env get-value "$name")
    fi
    if [ -z "$value" ]; then
        echo "Required azd environment value '$name' is missing." >&2
        exit 1
    fi
    printf '%s' "$value"
}

retry() {
    attempts=$1
    delay=$2
    shift 2
    count=1
    while ! "$@"; do
        if [ "$count" -ge "$attempts" ]; then
            return 1
        fi
        count=$((count + 1))
        sleep "$delay"
    done
}

PARAMETER_PATH=
BUILD_CONTEXT=
REGISTRY_PASSWORD=
cleanup() {
    if [ -n "$PARAMETER_PATH" ] && [ -f "$PARAMETER_PATH" ]; then
        rm -f -- "$PARAMETER_PATH"
    fi
    if [ -n "$BUILD_CONTEXT" ] && [ -d "$BUILD_CONTEXT" ]; then
        BUILD_CONTEXT_TO_REMOVE=$BUILD_CONTEXT node <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const target = path.resolve(process.env.BUILD_CONTEXT_TO_REMOVE);
const temporaryRoot = path.resolve(os.tmpdir());
if (
  path.dirname(target) !== temporaryRoot ||
  !path.basename(target).startsWith('function-image.')
) {
  throw new Error(`Refusing to remove unexpected path: ${target}`);
}
fs.rmSync(target, { recursive: true, force: true });
NODE
    fi
    REGISTRY_PASSWORD=
    STORAGE_CONNECTION_STRING=
    unset REGISTRY_PASSWORD
    unset STORAGE_CONNECTION_STRING
}
trap cleanup EXIT INT TERM

AZURE_SUBSCRIPTION_ID=$(get_azd_value AZURE_SUBSCRIPTION_ID)
AZURE_ENV_NAME=$(get_azd_value AZURE_ENV_NAME)
AZURE_RESOURCE_GROUP=$(get_azd_value AZURE_RESOURCE_GROUP)
AZURE_CONTAINER_REGISTRY_NAME=$(get_azd_value AZURE_CONTAINER_REGISTRY_NAME)
AZURE_CONTAINER_REGISTRY_ENDPOINT=$(get_azd_value AZURE_CONTAINER_REGISTRY_ENDPOINT)
AZURE_IMAGE_REPOSITORY=$(get_azd_value AZURE_IMAGE_REPOSITORY)
AZURE_ACR_TOKEN_NAME=$(get_azd_value AZURE_ACR_TOKEN_NAME)
AZURE_FUNCTION_NAME=$(get_azd_value AZURE_FUNCTION_NAME)
AZURE_FUNCTION_LOCATION=$(get_azd_value AZURE_FUNCTION_LOCATION)
AZURE_APP_SERVICE_PLAN_ID=$(get_azd_value AZURE_APP_SERVICE_PLAN_ID)
AZURE_STORAGE_ACCOUNT_NAME=$(get_azd_value AZURE_STORAGE_ACCOUNT_NAME)
AZURE_APPLICATION_INSIGHTS_CONNECTION_STRING=$(
    get_azd_value AZURE_APPLICATION_INSIGHTS_CONNECTION_STRING
)

az account set --subscription "$AZURE_SUBSCRIPTION_ID"

GIT_REVISION=$(git rev-parse --short=12 HEAD)
TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
IMAGE_TAG="azd-$GIT_REVISION-$TIMESTAMP"
TAGGED_IMAGE="$AZURE_IMAGE_REPOSITORY:$IMAGE_TAG"

BUILD_CONTEXT=$(mktemp -d "${TMPDIR:-/tmp}/function-image.XXXXXX")
for file in \
    .dockerignore \
    host.json \
    node24.Dockerfile \
    package-lock.json \
    package.json \
    tsconfig.json
do
    cp -- "$file" "$BUILD_CONTEXT/$file"
done
cp -R -- src "$BUILD_CONTEXT/src"
cp -R -- vendor "$BUILD_CONTEXT/vendor"

echo "Building Linux AMD64 image $AZURE_CONTAINER_REGISTRY_ENDPOINT/$TAGGED_IMAGE"
az acr login \
    --name "$AZURE_CONTAINER_REGISTRY_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --only-show-errors
docker buildx build \
    --platform linux/amd64 \
    --file "$BUILD_CONTEXT/node24.Dockerfile" \
    --tag "$AZURE_CONTAINER_REGISTRY_ENDPOINT/$TAGGED_IMAGE" \
    --push \
    --provenance=false \
    "$BUILD_CONTEXT"

get_digest() {
    DIGEST=$(az acr manifest show-metadata \
        --registry "$AZURE_CONTAINER_REGISTRY_NAME" \
        --name "$TAGGED_IMAGE" \
        --query digest \
        --output tsv \
        --only-show-errors)
    printf '%s' "$DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'
}
retry 6 10 get_digest
REGISTRY_IMAGE="$AZURE_CONTAINER_REGISTRY_ENDPOINT/$TAGGED_IMAGE@$DIGEST"

get_password() {
    REGISTRY_PASSWORD=$(az acr token credential generate \
        --registry "$AZURE_CONTAINER_REGISTRY_NAME" \
        --resource-group "$AZURE_RESOURCE_GROUP" \
        --name "$AZURE_ACR_TOKEN_NAME" \
        --password1 \
        --expiration-in-days 30 \
        --query "passwords[?name=='password1'].value | [0]" \
        --output tsv \
        --only-show-errors)
    [ -n "$REGISTRY_PASSWORD" ]
}
retry 6 10 get_password

STORAGE_CONNECTION_STRING=$(az storage account show-connection-string \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$AZURE_STORAGE_ACCOUNT_NAME" \
    --query connectionString \
    --output tsv \
    --only-show-errors)
if [ -z "$STORAGE_CONNECTION_STRING" ]; then
    echo "Storage connection-string retrieval returned no value." >&2
    exit 1
fi

PARAMETER_PATH=$(mktemp "${TMPDIR:-/tmp}/function-app.XXXXXX.parameters.json")
export PARAMETER_PATH REGISTRY_PASSWORD REGISTRY_IMAGE
export AZURE_ENV_NAME AZURE_FUNCTION_NAME AZURE_FUNCTION_LOCATION
export AZURE_APP_SERVICE_PLAN_ID STORAGE_CONNECTION_STRING
export AZURE_APPLICATION_INSIGHTS_CONNECTION_STRING AZURE_ACR_TOKEN_NAME

node <<'NODE'
const fs = require('node:fs');

const parameters = {
  $schema:
    'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
  contentVersion: '1.0.0.0',
  parameters: {
    environmentName: { value: process.env.AZURE_ENV_NAME },
    functionAppName: { value: process.env.AZURE_FUNCTION_NAME },
    functionLocation: { value: process.env.AZURE_FUNCTION_LOCATION },
    appServicePlanId: { value: process.env.AZURE_APP_SERVICE_PLAN_ID },
    applicationInsightsConnectionString: {
      value: process.env.AZURE_APPLICATION_INSIGHTS_CONNECTION_STRING,
    },
    storageConnectionString: {
      value: process.env.STORAGE_CONNECTION_STRING,
    },
    registryImage: { value: process.env.REGISTRY_IMAGE },
    registryUsername: { value: process.env.AZURE_ACR_TOKEN_NAME },
    registryPassword: { value: process.env.REGISTRY_PASSWORD },
  },
};

fs.writeFileSync(
  process.env.PARAMETER_PATH,
  `${JSON.stringify(parameters, null, 2)}\n`,
  { mode: 0o600 },
);
NODE

DEPLOYMENT_NAME="registry-app-$TIMESTAMP"
STATE=$(az deployment group create \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$DEPLOYMENT_NAME" \
    --template-file ./infra/app/api.bicep \
    --parameters "@$PARAMETER_PATH" \
    --query properties.provisioningState \
    --output tsv \
    --only-show-errors)
if [ "$STATE" != "Succeeded" ]; then
    echo "Registry Function App deployment ended in state '$STATE'." >&2
    exit 1
fi

azd env set AZURE_IMAGE_TAG "$IMAGE_TAG" --no-prompt >/dev/null
azd env set AZURE_IMAGE_DIGEST "$DIGEST" --no-prompt >/dev/null
azd env set AZURE_REGISTRY_IMAGE "$REGISTRY_IMAGE" --no-prompt >/dev/null
azd env set API_URL "https://$AZURE_FUNCTION_NAME.azurewebsites.net" --no-prompt \
    >/dev/null

az functionapp restart \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$AZURE_FUNCTION_NAME" \
    --only-show-errors

echo "Created Registry-backed Function App '$AZURE_FUNCTION_NAME'."
echo "Pinned image: $REGISTRY_IMAGE"
