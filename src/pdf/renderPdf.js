const puppeteer = require('puppeteer-core');

const CHROMIUM_EXECUTABLE = process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium';
const MAX_HTML_BYTES = 256 * 1024;
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT_RENDERS = 1;
const CHROMIUM_ARGS = Object.freeze([
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints',
    '--disable-sync',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-default-browser-check',
    '--no-first-run',
]);

let activeRenders = 0;

class PdfRenderError extends Error {
    constructor(code, message, status) {
        super(message);
        this.name = 'PdfRenderError';
        this.code = code;
        this.status = status;
    }
}

function isAllowedSubresourceUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'about:' || url.protocol === 'data:';
    } catch {
        return false;
    }
}

function safePdfFilename(value, fallback = 'document') {
    const source = String(value || fallback)
        .normalize('NFKD')
        .replace(/[^\x20-\x7E]+/g, '-')
        .replace(/\.pdf$/i, '');
    const safe = source
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, 64);

    return `${safe || fallback}.pdf`;
}

function assertHtmlSize(html) {
    const size = Buffer.byteLength(html, 'utf8');
    if (size === 0) {
        throw new PdfRenderError('EMPTY_HTML', 'The HTML body is empty.', 400);
    }
    if (size > MAX_HTML_BYTES) {
        throw new PdfRenderError(
            'HTML_TOO_LARGE',
            `The HTML body exceeds the ${MAX_HTML_BYTES}-byte limit.`,
            413,
        );
    }
}

async function readHtmlRequest(request) {
    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES) {
        throw new PdfRenderError(
            'HTML_TOO_LARGE',
            `The HTML body exceeds the ${MAX_HTML_BYTES}-byte limit.`,
            413,
        );
    }

    let body;
    if (request.body && typeof request.body.getReader === 'function') {
        const reader = request.body.getReader();
        const chunks = [];
        let total = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            total += value.byteLength;
            if (total > MAX_HTML_BYTES) {
                await reader.cancel('HTML body exceeds the configured limit.');
                throw new PdfRenderError(
                    'HTML_TOO_LARGE',
                    `The HTML body exceeds the ${MAX_HTML_BYTES}-byte limit.`,
                    413,
                );
            }
            chunks.push(Buffer.from(value));
        }

        body = Buffer.concat(chunks);
    } else if (typeof request.arrayBuffer === 'function') {
        body = Buffer.from(await request.arrayBuffer());
    } else {
        body = Buffer.from(await request.text(), 'utf8');
    }

    if (body.length > MAX_HTML_BYTES) {
        throw new PdfRenderError(
            'HTML_TOO_LARGE',
            `The HTML body exceeds the ${MAX_HTML_BYTES}-byte limit.`,
            413,
        );
    }

    let html;
    try {
        html = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
        throw new PdfRenderError('INVALID_UTF8', 'The HTML body must be valid UTF-8.', 400);
    }

    assertHtmlSize(html);
    return html;
}

function withTimeout(promise, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new PdfRenderError('RENDER_TIMEOUT', 'PDF rendering timed out.', 504));
        }, timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function handleInterceptedRequest(request) {
    if (
        typeof request.isInterceptResolutionHandled === 'function' &&
        request.isInterceptResolutionHandled()
    ) {
        return;
    }

    if (isAllowedSubresourceUrl(request.url())) {
        await request.continue();
        return;
    }

    await request.abort('blockedbyclient');
}

async function renderHtmlToPdf(html) {
    assertHtmlSize(html);
    if (activeRenders >= MAX_CONCURRENT_RENDERS) {
        throw new PdfRenderError('RENDER_BUSY', 'A PDF render is already in progress.', 503);
    }

    activeRenders += 1;
    let browser;
    let page;
    let primaryError;
    const interceptionErrors = [];

    try {
        // Keep Chromium sandboxing enabled: do not add --no-sandbox or --disable-setuid-sandbox.
        browser = await puppeteer.launch({
            executablePath: CHROMIUM_EXECUTABLE,
            headless: true,
            timeout: 15_000,
            protocolTimeout: RENDER_TIMEOUT_MS,
            args: [...CHROMIUM_ARGS],
        });

        page = await browser.newPage();
        await page.setJavaScriptEnabled(false);
        await page.setOfflineMode(true);
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            void handleInterceptedRequest(request).catch((error) => {
                interceptionErrors.push(error);
            });
        });
        page.setDefaultTimeout(RENDER_TIMEOUT_MS);
        await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
        await page.emulateMediaType('print');
        await page.setContent(html, {
            waitUntil: 'domcontentloaded',
            timeout: RENDER_TIMEOUT_MS,
        });

        if (interceptionErrors.length > 0) {
            throw new PdfRenderError(
                'REQUEST_INTERCEPTION_FAILED',
                'A browser request could not be safely resolved.',
                500,
            );
        }

        const pdf = Buffer.from(
            await withTimeout(
                page.pdf({
                    format: 'A4',
                    printBackground: true,
                    preferCSSPageSize: true,
                    displayHeaderFooter: false,
                    margin: {
                        top: '0',
                        right: '0',
                        bottom: '0',
                        left: '0',
                    },
                }),
                RENDER_TIMEOUT_MS,
            ),
        );

        if (pdf.length > MAX_PDF_BYTES) {
            throw new PdfRenderError(
                'PDF_TOO_LARGE',
                `The generated PDF exceeds the ${MAX_PDF_BYTES}-byte limit.`,
                413,
            );
        }

        return pdf;
    } catch (error) {
        if (error instanceof PdfRenderError) {
            primaryError = error;
        } else {
            const timedOut = /timeout|timed out/i.test(error.message);
            primaryError = new PdfRenderError(
                timedOut ? 'RENDER_TIMEOUT' : 'RENDER_FAILED',
                timedOut ? 'PDF rendering timed out.' : 'PDF rendering failed.',
                timedOut ? 504 : 500,
            );
            primaryError.cause = error;
        }
        throw primaryError;
    } finally {
        const cleanupErrors = [];
        if (page && !page.isClosed()) {
            try {
                await page.close();
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (browser) {
            try {
                await browser.close();
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        activeRenders -= 1;

        if (primaryError && cleanupErrors.length > 0) {
            primaryError.cleanupErrors = cleanupErrors;
        } else if (!primaryError && cleanupErrors.length > 0) {
            throw new PdfRenderError('CLEANUP_FAILED', 'Browser cleanup failed.', 500);
        }
    }
}

function defaultInvoiceHtml() {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Contoso Studio Invoice</title>
    <style>
        @page { size: A4; margin: 0; }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; background: #eef2ff; color: #172033; }
        body {
            font-family: "DejaVu Sans", "Liberation Sans", Arial, sans-serif;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }
        .page {
            min-height: 297mm;
            padding: 18mm;
            background: linear-gradient(145deg, #f8fafc 0%, #eef2ff 46%, #ffffff 100%);
        }
        .card {
            min-height: 255mm;
            padding: 14mm;
            border: 1px solid #dbe4ff;
            border-radius: 18px;
            background: rgba(255,255,255,.96);
            box-shadow: 0 18px 50px rgba(49, 46, 129, .12);
        }
        .header { display: flex; justify-content: space-between; gap: 24px; }
        .brand { display: flex; align-items: center; gap: 12px; }
        .mark {
            width: 46px; height: 46px; border-radius: 14px;
            background: linear-gradient(135deg, #4f46e5, #7c3aed);
            color: white; display: grid; place-items: center; font-weight: 800; font-size: 22px;
        }
        h1 { margin: 0; font-size: 27px; letter-spacing: -.5px; }
        .muted { color: #64748b; font-size: 12px; line-height: 1.55; }
        .invoice-title { text-align: right; }
        .invoice-title strong { display: block; font-size: 24px; color: #4f46e5; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; margin: 28px 0; }
        .panel { padding: 16px; border-radius: 12px; background: #f8fafc; border: 1px solid #e2e8f0; }
        .panel b { display: block; margin-bottom: 6px; font-size: 12px; color: #475569; text-transform: uppercase; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        th { padding: 11px 10px; text-align: left; color: #475569; font-size: 11px; text-transform: uppercase; border-bottom: 2px solid #c7d2fe; }
        td { padding: 14px 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; }
        th:last-child, td:last-child { text-align: right; }
        .totals { width: 46%; margin-left: auto; margin-top: 20px; }
        .totals div { display: flex; justify-content: space-between; padding: 7px 0; font-size: 12px; }
        .totals .grand { margin-top: 6px; padding-top: 12px; border-top: 2px solid #4f46e5; font-size: 17px; font-weight: 800; color: #312e81; }
        .note { margin-top: 30px; padding: 14px 16px; border-left: 4px solid #6366f1; background: #eef2ff; border-radius: 0 10px 10px 0; }
        .footer { margin-top: 28px; display: flex; justify-content: space-between; align-items: end; }
        .status { padding: 7px 12px; border-radius: 999px; background: #dcfce7; color: #166534; font-size: 11px; font-weight: 700; }
    </style>
</head>
<body>
    <main class="page">
        <section class="card">
            <header class="header">
                <div class="brand">
                    <div class="mark">C</div>
                    <div>
                        <h1>Contoso Studio</h1>
                        <div class="muted">Design systems and product experiences</div>
                    </div>
                </div>
                <div class="invoice-title">
                    <strong>INVOICE</strong>
                    <span class="muted">INV-2026-1109</span>
                </div>
            </header>
            <section class="grid">
                <div class="panel">
                    <b>Bill to</b>
                    <div>Northwind Traders</div>
                    <div class="muted">1 Market Street<br>Seattle, WA 98101</div>
                </div>
                <div class="panel">
                    <b>Invoice details</b>
                    <div class="muted">Issued: November 9, 2026<br>Due: December 9, 2026<br>Terms: Net 30</div>
                </div>
            </section>
            <table>
                <thead>
                    <tr><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>
                </thead>
                <tbody>
                    <tr><td>Product discovery workshop</td><td>1</td><td>$2,400.00</td><td>$2,400.00</td></tr>
                    <tr><td>Design system implementation</td><td>48</td><td>$185.00</td><td>$8,880.00</td></tr>
                    <tr><td>Accessibility review</td><td>12</td><td>$165.00</td><td>$1,980.00</td></tr>
                </tbody>
            </table>
            <section class="totals">
                <div><span>Subtotal</span><span>$13,260.00</span></div>
                <div><span>Tax (8.5%)</span><span>$1,127.10</span></div>
                <div class="grand"><span>Total</span><span>$14,387.10</span></div>
            </section>
            <section class="note">
                <strong>Thank you for your partnership.</strong>
                <div class="muted">Please include invoice INV-2026-1109 with your payment.</div>
            </section>
            <footer class="footer">
                <div class="muted">billing@contoso.example<br>+1 206 555 0142</div>
                <div class="status">PAYMENT PENDING</div>
            </footer>
        </section>
    </main>
</body>
</html>`;
}

module.exports = {
    CHROMIUM_ARGS,
    MAX_HTML_BYTES,
    MAX_PDF_BYTES,
    PdfRenderError,
    defaultInvoiceHtml,
    isAllowedSubresourceUrl,
    readHtmlRequest,
    renderHtmlToPdf,
    safePdfFilename,
};
