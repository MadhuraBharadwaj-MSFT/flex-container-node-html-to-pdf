# Flex Container Node HTML-to-PDF

Validated Azure Functions Flex Consumption BYOC sample for Node.js 24. It runs
the standalone Azure Functions Node worker in a Linux AMD64 container and
renders bounded HTML to PDF with `puppeteer-core` and Debian's OS-installed
Chromium.

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

## Verified versions

- Node.js `24.22.2`
- Azure Functions Node worker `3.17.1`
- `@azure/functions` `4.17.0`
- `puppeteer-core` `25.16.0`
- Debian Chromium `156.0.8078.79`

The worker archive is checksum-pinned:

```text
424407adbde0d2ad922cb1116bb4e70de551c6744e3d01ec72542633f5db33c2
```

## BYOC application-directory requirement

The worker image uses `/home/site/wwwroot` and explicitly sets:

```dockerfile
ENV FUNCTIONS_APPLICATION_DIRECTORY=/home/site/wwwroot
```

Without this setting, the preview platform can report `AppDirectoryNotSet`,
prevent Host configuration delivery and function indexing.

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
|-- host.json
|-- src
|   |-- functions
|   |   |-- hello.js
|   |   `-- htmlToPdf.js
|   `-- pdf
|       |-- httpHandler.js
|       `-- renderPdf.js
`-- test
    `-- htmlToPdf.test.js
```

## Run focused tests

Use Node.js 24:

```powershell
npm ci
npm test
```

The tests cover filename safety, input limits, media-type validation, external
resource blocking, JavaScript controls, response headers, and sandbox-preserving
Chromium arguments.

## Optional local Functions Host

Copy the example settings:

```powershell
Copy-Item .\local.settings.example.json .\local.settings.json
```

Set `CHROMIUM_EXECUTABLE` in `local.settings.json` to an installed Chromium,
Chrome, or Edge executable, then run:

```powershell
npm ci
func start
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
  --tag flex-container-node-html-to-pdf:local `
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
const { defaultInvoiceHtml, renderHtmlToPdf } = require('./src/pdf/renderPdf');

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
  flex-container-node-html-to-pdf:local -
```

## Azure verification

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
