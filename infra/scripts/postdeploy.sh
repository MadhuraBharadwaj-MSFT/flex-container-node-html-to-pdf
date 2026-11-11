#!/usr/bin/env sh
set -eu

# Root-level azd hooks run with the repository as their working directory.
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

AZURE_SUBSCRIPTION_ID=$(get_azd_value AZURE_SUBSCRIPTION_ID)
AZURE_RESOURCE_GROUP=$(get_azd_value AZURE_RESOURCE_GROUP)
AZURE_FUNCTION_NAME=$(get_azd_value AZURE_FUNCTION_NAME)
API_URL=$(get_azd_value API_URL)
AZURE_REGISTRY_IMAGE=$(get_azd_value AZURE_REGISTRY_IMAGE)
API_URL=${API_URL%/}
SITE_ID="/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/$AZURE_RESOURCE_GROUP/providers/Microsoft.Web/sites/$AZURE_FUNCTION_NAME"

az account set --subscription "$AZURE_SUBSCRIPTION_ID"

EXPECTED_HELLO='Hello from the BYOC Node.js worker.'
ATTEMPT=1
MAX_ATTEMPTS=36
RESTARTED=false
HELLO_BODY=

while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
    if HELLO_BODY=$(curl --fail --silent --show-error --max-time 30 \
        "$API_URL/api/hello" 2>/dev/null) &&
        [ "$HELLO_BODY" = "$EXPECTED_HELLO" ]; then
        break
    fi

    if [ "$ATTEMPT" -eq 12 ] && [ "$RESTARTED" = false ]; then
        az functionapp restart \
            --resource-group "$AZURE_RESOURCE_GROUP" \
            --name "$AZURE_FUNCTION_NAME" \
            --only-show-errors
        RESTARTED=true
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 10
done

if [ "$HELLO_BODY" != "$EXPECTED_HELLO" ]; then
    echo "The Hello endpoint did not become healthy within six minutes." >&2
    exit 1
fi

HELLO_POST=$(curl --fail --silent --show-error --max-time 30 \
    --request POST "$API_URL/api/hello")
if [ "$HELLO_POST" != "$EXPECTED_HELLO" ]; then
    echo "The Hello POST response did not match the expected oracle." >&2
    exit 1
fi

FUNCTION_NAMES=$(az rest \
    --method get \
    --url "https://management.azure.com$SITE_ID/functions?api-version=2026-08-01" \
    --query 'value[].name' \
    --output tsv)
printf '%s\n' "$FUNCTION_NAMES" | grep -Eq '(^|/)Hello$'
printf '%s\n' "$FUNCTION_NAMES" | grep -Eq '(^|/)HtmlToPdf$'

DEPLOYMENT_JSON=$(az rest \
    --method get \
    --url "https://management.azure.com$SITE_ID?api-version=2026-08-01" \
    --query '{state:properties.state,type:properties.functionAppConfig.deployment.storage.type,value:properties.functionAppConfig.deployment.storage.value}' \
    --output json)
export DEPLOYMENT_JSON AZURE_REGISTRY_IMAGE
node <<'NODE'
const deployment = JSON.parse(process.env.DEPLOYMENT_JSON);
if (
  deployment.state !== 'Running' ||
  deployment.type !== 'Registry' ||
  deployment.value !== process.env.AZURE_REGISTRY_IMAGE
) {
  throw new Error('The Function App Registry configuration does not match.');
}
NODE

SETTING_NAMES=$(az rest \
    --method post \
    --url "https://management.azure.com$SITE_ID/config/appsettings/list?api-version=2026-08-01" \
    --query 'keys(properties)' \
    --output tsv)
for forbidden in \
    FUNCTIONS_APPLICATION_DIRECTORY \
    AzureWebJobsScriptRoot \
    WEBSITE_RUN_FROM_PACKAGE
do
    if printf '%s\n' "$SETTING_NAMES" | grep -Fxq "$forbidden"; then
        echo "Forbidden application setting '$forbidden' is present." >&2
        exit 1
    fi
done

INVOICE_PATH=$(mktemp "${TMPDIR:-/tmp}/invoice.XXXXXX.pdf")
CUSTOM_PATH=$(mktemp "${TMPDIR:-/tmp}/custom.XXXXXX.pdf")
cleanup() {
    rm -f -- "$INVOICE_PATH" "$CUSTOM_PATH"
}
trap cleanup EXIT INT TERM

curl --fail --silent --show-error --max-time 120 \
    "$API_URL/api/html-to-pdf" \
    --output "$INVOICE_PATH"

curl --fail --silent --show-error --max-time 120 \
    --request POST \
    --header 'Content-Type: text/html; charset=utf-8' \
    --header 'X-Pdf-Filename: azd-validation.pdf' \
    --data-binary '<!doctype html><html lang="en"><body><h1>AZD Registry validation</h1><p>Rendered from bounded raw HTML.</p></body></html>' \
    "$API_URL/api/html-to-pdf" \
    --output "$CUSTOM_PATH"

export INVOICE_PATH CUSTOM_PATH FUNCTION_NAMES AZURE_FUNCTION_NAME
VERIFICATION_JSON=$(node <<'NODE'
const fs = require('node:fs');

function validatePdf(path) {
  const pdf = fs.readFileSync(path);
  const prefix = pdf.subarray(0, 5).toString('ascii');
  const tail = pdf.subarray(Math.max(0, pdf.length - 128)).toString('ascii');
  if (pdf.length < 100 || prefix !== '%PDF-' || !/%%EOF\s*$/.test(tail)) {
    throw new Error(`Invalid PDF: ${path}`);
  }
  return pdf.length;
}

process.stdout.write(JSON.stringify({
  functionApp: process.env.AZURE_FUNCTION_NAME,
  functions: process.env.FUNCTION_NAMES.split(/\r?\n/).filter(Boolean),
  helloGet: 200,
  helloPost: 200,
  pdfGetBytes: validatePdf(process.env.INVOICE_PATH),
  pdfPostBytes: validatePdf(process.env.CUSTOM_PATH),
}));
NODE
)

VERIFIED_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
azd env set AZURE_VERIFIED_UTC "$VERIFIED_UTC" --no-prompt >/dev/null
printf '%s\n' "$VERIFICATION_JSON"
