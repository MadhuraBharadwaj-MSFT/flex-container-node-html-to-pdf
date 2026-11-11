# Flex Container TypeScript HTML-to-PDF

TypeScript-first Azure Functions Flex Consumption BYOC sample for Node.js 24.
It compiles strict TypeScript into the application directory, runs the
standalone Azure Functions Node worker in a Linux AMD64 container, and renders
bounded HTML to PDF with `puppeteer-core` and Debian's OS-installed Chromium.

The repository root is the primary TypeScript implementation. The previously
validated JavaScript implementation remains available in
[`javascript/`](./javascript/README.md).

> This uses a preview BYOC hosting contract. It is sample guidance, not a
> production support policy. The HTTP triggers are anonymous for validation;
> add authentication, authorization, and abuse controls before production use.

## What it exposes

| Method | Route | Behavior |
|---|---|---|
| GET / POST | `/api/hello` | Returns `Hello from the BYOC Node.js worker.` |
| GET | `/api/html-to-pdf` | Returns a built-in polished invoice PDF |
| POST | `/api/html-to-pdf` | Converts bounded raw `text/html` to PDF |

POST accepts an optional `X-Pdf-Filename` header. The value is sanitized before
being used in `Content-Disposition`.

## TypeScript build and runtime flow

```text
src/**/*.ts
    |
    | tsc --strict
    v
dist/functions/*.js + dist/pdf/*.js
    |
    | copied into the final image
    v
/home/site/wwwroot/dist
    |
    | package.json main = dist/functions/*.js
    v
Azure Functions Node worker 3.17.3
```

The multi-stage image installs TypeScript only in the build stage. Exact
build-only tarballs for TypeScript, Node.js types, and `undici-types` are
vendored under `vendor/` so container builds do not depend on a second package
feed for compiler tooling. The runtime image contains compiled JavaScript,
production dependencies, the standalone Node worker, Chromium, and fonts. It
does not contain TypeScript source, TypeScript compiler packages, the vendored
tarballs, Functions Host, or WorkerProxy.

## Verified versions

- Node.js `24.22.2`
- TypeScript `5.9.3`
- Azure Functions Node worker `3.17.3`
- `@azure/functions` `4.17.0`
- `puppeteer-core` `25.16.0`
- Debian Chromium `156.0.8078.79`

The worker archive is checksum-pinned:

```text
93fbe6f007a5eab62f28e30b3fbb93c61c53ba3b9890cc135d982a8af1e4f3ca
```

## BYOC application directory

Worker `3.17.3` consumes the application directory supplied by the preview
Host/WorkerProxy contract. The image uses `/home/site/wwwroot` as its working
directory and does not set `FUNCTIONS_APPLICATION_DIRECTORY` or
`AzureWebJobsScriptRoot`.

The TypeScript build emits function entrypoints to:

```text
/home/site/wwwroot/dist/functions
```

## Rendering controls

- HTML input limit: 256 KiB
- PDF output limit: 5 MiB
- Chromium launch timeout: 15 seconds
- Content and PDF timeout: 20 seconds
- One concurrent render per worker process
- JavaScript disabled
- Browser offline mode enabled
- Request interception allows only `about:` and `data:` resources
- No URL parameter or arbitrary URL-fetch feature
- Safe ASCII output filenames
- Browser and page cleanup after every render
- Non-root `node` user
- Chromium sandbox retained

The image installs both `chromium` and `chromium-sandbox`. It never adds
`--no-sandbox` or `--disable-setuid-sandbox`.

`puppeteer-core` is used intentionally. The package does not download a second
browser; the only browser is Debian's Chromium package.

## Repository layout

```text
.
|-- node24.Dockerfile
|-- azure.yaml
|-- package.json
|-- package-lock.json
|-- tsconfig.json
|-- infra
|   |-- abbreviations.json
|   |-- main.bicep
|   |-- main.parameters.json
|   |-- app
|   |   |-- api.bicep
|   |   `-- foundation.bicep
|   `-- scripts
|       |-- postprovision.ps1
|       |-- postprovision.sh
|       |-- postdeploy.ps1
|       `-- postdeploy.sh
|-- vendor
|   |-- types-node-24.10.0.tgz
|   |-- typescript-5.9.3.tgz
|   `-- undici-types-7.16.0.tgz
|-- host.json
|-- src
|   |-- functions
|   |   |-- hello.ts
|   |   `-- htmlToPdf.ts
|   `-- pdf
|       |-- httpHandler.ts
|       `-- renderPdf.ts
|-- test
|   `-- htmlToPdf.test.js
`-- javascript
    |-- README.md
    `-- ... runnable JavaScript sample
```

## Build and run focused tests

Use Node.js 24:

```powershell
npm ci
npm run build
npm test
```

`npm test` performs a clean TypeScript build before running the focused tests.
The tests cover filename safety, input limits, media-type validation, external
resource blocking, JavaScript controls, response headers, and
sandbox-preserving Chromium arguments.

## Optional local Functions Host

Copy the example settings:

```powershell
Copy-Item .\local.settings.example.json .\local.settings.json
```

Set `CHROMIUM_EXECUTABLE` in `local.settings.json` to an installed Chromium,
Chrome, or Edge executable, then run:

```powershell
npm ci
npm start
```

Test the built-in invoice:

```powershell
curl.exe -fS `
  http://localhost:7071/api/html-to-pdf `
  --output invoice.pdf
```

Test POST:

```powershell
@'
<!doctype html>
<html>
<body>
  <h1>Custom PDF</h1>
  <p>Rendered from bounded raw HTML.</p>
</body>
</html>
'@ | Set-Content .\custom.html -Encoding utf8

curl.exe -fS `
  -X POST `
  -H "Content-Type: text/html; charset=utf-8" `
  -H "X-Pdf-Filename: custom.pdf" `
  --data-binary "@custom.html" `
  http://localhost:7071/api/html-to-pdf `
  --output custom.pdf
```

## Build the Linux AMD64 worker image

```powershell
docker buildx build `
  --platform linux/amd64 `
  --file .\node24.Dockerfile `
  --tag flex-container-node-html-to-pdf:typescript `
  --load `
  --provenance=false `
  .
```

The image is worker-only. It does not contain Functions Host or WorkerProxy and
does not expose an HTTP port. The platform supplies the worker's gRPC startup
arguments.

## In-container PDF smoke test

Docker Desktop can block Chromium's nested namespace transition. The following
test-only capability lets Chromium exercise its sandbox locally; the deployed
Azure environment did not require a no-sandbox fallback.

```powershell
@'
const { defaultInvoiceHtml, renderHtmlToPdf } = require('./dist/pdf/renderPdf');

(async () => {
  const pdf = await renderHtmlToPdf(defaultInvoiceHtml());
  const prefix = pdf.subarray(0, 5).toString('ascii');
  const tail = pdf.subarray(Math.max(0, pdf.length - 64)).toString('ascii');
  if (prefix !== '%PDF-' || !/%%EOF\s*$/.test(tail)) {
    throw new Error('Invalid PDF');
  }
  console.log({ bytes: pdf.length, prefix });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
'@ | docker run -i --rm `
  --platform linux/amd64 `
  --cap-add SYS_ADMIN `
  --entrypoint node `
  flex-container-node-html-to-pdf:typescript -
```

## JavaScript reference

The original implementation is self-contained under [`javascript/`](./javascript/).
From that folder:

```powershell
npm ci
npm test
```

Its Dockerfile and lockfile remain independent of the TypeScript root sample.

## Azure verification

The compiled TypeScript application layout was verified on Azure Flex
Consumption BYOC with both application-directory environment variables absent.
Azure indexed `Hello` and `HtmlToPdf` from
`/home/site/wwwroot/dist/functions`; Hello and both PDF methods returned HTTP
200, and the GET and POST files had valid `%PDF-` and `%%EOF` markers.

After deploying the image through the Flex Consumption BYOC Registry contract,
verify both methods:

```powershell
$baseUrl = 'https://<function-app-hostname>'

curl.exe -fS --max-time 120 `
  "$baseUrl/api/html-to-pdf" `
  --output invoice.pdf

curl.exe -fS --max-time 120 `
  -X POST `
  -H "Content-Type: text/html; charset=utf-8" `
  -H "X-Pdf-Filename: custom.pdf" `
  --data-binary "@custom.html" `
  "$baseUrl/api/html-to-pdf" `
  --output custom.pdf
```

Successful files begin with `%PDF-` and end with `%%EOF`.

## Deploy with Azure Developer CLI

The `azd` deployment creates the Function App directly as a Registry-backed
Flex Consumption app. It does not create a code-deployed Function App and then
convert it.

### Prerequisites

- Azure CLI
- Azure Developer CLI
- Docker Engine or Docker Desktop with Buildx
- Node.js 24
- An Azure account with permission to create resource groups, role
  assignments, ACR builds, and Flex Consumption resources
- Access to the Flex Consumption BYOC preview in the target subscription

Sign in:

```powershell
az login
azd auth login
```

### Azure architecture

The `infra/` layout follows the official Azure Functions `azd` sample pattern:
shared abbreviations at the root, application modules under `infra/app/`, and
deployment hooks under `infra/scripts/`.

The foundation Bicep creates:

- one resource group;
- one Standard_LRS storage account for Functions runtime state;
- one Log Analytics workspace and Application Insights component;
- one Basic Azure Container Registry with admin access disabled;
- one repository-scoped read-only ACR token;
- one FC1 Flex Consumption plan.

The `postprovision` hook then:

1. Stages a minimal build context so local dependency folders are excluded.
2. Builds `node24.Dockerfile` with Docker Buildx as Linux AMD64 and pushes it
   to ACR. Buildx is used because the checksum-pinned `ADD` instruction requires
   a current Dockerfile frontend.
3. Resolves the immutable image digest.
4. Rotates a 30-day password for the read-only pull token.
5. Creates the Function App directly with:

   ```text
   functionAppConfig.deployment.storage.type = Registry
   ```

6. Pins the app to `registry/repository:tag@sha256:digest`.
7. Restarts the app once.

The token password and runtime storage connection string are passed as secure
Bicep parameters. Neither value is committed, printed, emitted as a deployment
output, or saved in the `azd` environment. Rerunning `azd provision` or
`azd up` builds a new immutable image and rotates the 30-day registry
credential.

### Create the environment

Set the target subscription, standard resource location, and preview Function
App display location explicitly because local `azd` defaults can point
elsewhere:

```powershell
azd env new node-pdf-byoc --no-prompt
azd env set AZURE_SUBSCRIPTION_ID <subscription-id>
azd env set AZURE_LOCATION northcentralus
azd env set AZURE_FUNCTION_LOCATION "North Central US (Stage)"
```

Review the selected values:

```powershell
azd env get-values
```

### Provision, build, deploy, and verify

```powershell
azd up
```

`azd up` performs the infrastructure deployment, ACR build, direct Registry
Function App creation, and endpoint verification. The final hook verifies:

- Azure inventories `Hello` and `HtmlToPdf`;
- Hello GET and POST return the exact expected greeting;
- deployment storage type is `Registry`;
- the deployed image matches the immutable digest;
- `FUNCTIONS_APPLICATION_DIRECTORY`, `AzureWebJobsScriptRoot`, and
  `WEBSITE_RUN_FROM_PACKAGE` are absent;
- PDF GET and POST return non-empty files beginning with `%PDF-` and ending
  with `%%EOF`.

Useful deployment values:

```powershell
azd env get-value API_URL
azd env get-value AZURE_RESOURCE_GROUP
azd env get-value AZURE_FUNCTION_NAME
azd env get-value AZURE_REGISTRY_IMAGE
azd env get-value AZURE_VERIFIED_UTC
```

### Verify manually

```powershell
$baseUrl = azd env get-value API_URL

curl.exe -fS --max-time 120 `
  "$baseUrl/api/hello"

curl.exe -fS --max-time 120 `
  "$baseUrl/api/html-to-pdf" `
  --output invoice.pdf

curl.exe -fS --max-time 120 `
  -X POST `
  -H "Content-Type: text/html; charset=utf-8" `
  -H "X-Pdf-Filename: custom.pdf" `
  --data-binary "@custom.html" `
  "$baseUrl/api/html-to-pdf" `
  --output custom.pdf
```

### Preview limitations

- The Registry deployment contract uses `Microsoft.Web/sites@2026-08-01`.
- The validated Function App and plan location is
  `North Central US (Stage)`, while supporting resources use
  `northcentralus`.
- The Stage location currently rejects App Service managed identities. The
  Function App therefore uses the storage account connection string, supplied
  only as a secure Bicep parameter. Use managed identity instead when the
  Registry contract is available in a location that supports site identities.
- The image is worker-only. Azure supplies Functions Host and the worker
  transport outside the image.
- ACR and storage use public service endpoints for preview compatibility.
  Storage anonymous blob access is disabled; registry pull access is
  repository-scoped.
- HTTP triggers remain anonymous for sample validation. Add authentication,
  authorization, rate limiting, and abuse protection before production use.

### Retained cost items

An active environment retains an FC1 plan/app, ACR, storage account, Log
Analytics workspace, and Application Insights. ACR and monitoring can incur
charges even when the Function App is idle.

### Cleanup

Review the environment before deleting it:

```powershell
azd env get-values
az resource list `
  --resource-group (azd env get-value AZURE_RESOURCE_GROUP) `
  --output table
```

Delete the environment only when its retained resources are no longer needed:

```powershell
azd down --force
```

This deletes the resource group created for the selected `azd` environment. It
does not delete local source files.

### Troubleshooting

- If the app does not index functions immediately, wait for the bounded
  verification hook. It performs one clean restart after two minutes.
- If the Docker build or push fails, confirm Docker is running and rerun
  `azd provision`; the foundation deployment is idempotent.
- If the Registry credential expires, rerun `azd provision` or `azd up` to
  rotate it and repin the app.
- If Azure Policy denies a resource, do not weaken the policy. Review the
  failing assignment and adjust networking or resource settings.
- Do not add `FUNCTIONS_APPLICATION_DIRECTORY` or
  `AzureWebJobsScriptRoot`; worker 3.17.3 resolves `/home/site/wwwroot`
  without either override.

## License

MIT
