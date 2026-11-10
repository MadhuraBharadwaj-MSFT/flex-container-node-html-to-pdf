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
|-- package.json
|-- package-lock.json
|-- tsconfig.json
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

## License

MIT
