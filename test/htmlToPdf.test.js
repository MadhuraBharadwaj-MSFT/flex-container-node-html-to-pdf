const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    CHROMIUM_ARGS,
    MAX_HTML_BYTES,
    PdfRenderError,
    defaultInvoiceHtml,
    isAllowedSubresourceUrl,
    readHtmlRequest,
    safePdfFilename,
} = require('../dist/pdf/renderPdf');
const { htmlToPdfHandler } = require('../dist/pdf/httpHandler');

function makeContext() {
    return {
        errors: [],
        warnings: [],
        error(message, details) {
            this.errors.push({ message, details });
        },
        warn(message, details) {
            this.warnings.push({ message, details });
        },
    };
}

function makeRequest({
    method = 'POST',
    contentType = 'text/html',
    filename,
    text = '<p>Hello</p>',
    contentLength,
} = {}) {
    const encoded = new TextEncoder().encode(text);
    const headers = new Headers();
    if (contentType !== null) {
        headers.set('content-type', contentType);
    }
    if (filename) {
        headers.set('x-pdf-filename', filename);
    }
    if (contentLength !== undefined) {
        headers.set('content-length', String(contentLength));
    }

    return {
        method,
        headers,
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(encoded);
                controller.close();
            },
        }),
    };
}

test('safePdfFilename strips traversal and response-header characters', () => {
    assert.equal(safePdfFilename('../../invoice\r\nX.pdf'), 'invoice-X.pdf');
    assert.equal(safePdfFilename(' quarterly report '), 'quarterly-report.pdf');
    assert.equal(safePdfFilename(''), 'document.pdf');
});

test('subresource allowlist accepts only about and data URLs', () => {
    assert.equal(isAllowedSubresourceUrl('about:blank'), true);
    assert.equal(isAllowedSubresourceUrl('data:image/png;base64,AA=='), true);
    assert.equal(isAllowedSubresourceUrl('https://example.com/image.png'), false);
    assert.equal(isAllowedSubresourceUrl('file:///etc/passwd'), false);
    assert.equal(isAllowedSubresourceUrl('blob:https://example.com/id'), false);
});

test('Chromium launch arguments preserve sandboxing', () => {
    assert.equal(CHROMIUM_ARGS.includes('--no-sandbox'), false);
    assert.equal(CHROMIUM_ARGS.includes('--disable-setuid-sandbox'), false);
    assert.equal(CHROMIUM_ARGS.includes('--disable-background-networking'), true);
});

test('readHtmlRequest accepts bounded UTF-8 HTML', async () => {
    const html = await readHtmlRequest(makeRequest({ text: '<h1>Invoice</h1>' }));
    assert.equal(html, '<h1>Invoice</h1>');
});

test('readHtmlRequest rejects declared and actual oversized bodies', async () => {
    await assert.rejects(
        readHtmlRequest(makeRequest({ contentLength: MAX_HTML_BYTES + 1 })),
        (error) => error instanceof PdfRenderError && error.code === 'HTML_TOO_LARGE',
    );

    await assert.rejects(
        readHtmlRequest(makeRequest({ text: 'a'.repeat(MAX_HTML_BYTES + 1) })),
        (error) => error instanceof PdfRenderError && error.code === 'HTML_TOO_LARGE',
    );
});

test('GET returns a built-in invoice PDF with safe headers', async () => {
    const context = makeContext();
    let renderedHtml;
    const response = await htmlToPdfHandler(
        makeRequest({ method: 'GET' }),
        context,
        async (html) => {
            renderedHtml = html;
            return Buffer.from('%PDF-1.7\n%%EOF\n');
        },
    );

    assert.match(renderedHtml, /Contoso Studio/);
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Type'], 'application/pdf');
    assert.equal(response.headers['Content-Disposition'], 'attachment; filename="invoice.pdf"');
    assert.equal(context.errors.length, 0);
});

test('POST requires text/html and sanitizes the requested filename', async () => {
    const rejected = await htmlToPdfHandler(
        makeRequest({ contentType: 'application/json' }),
        makeContext(),
        async () => Buffer.from('unused'),
    );
    assert.equal(rejected.status, 415);

    const accepted = await htmlToPdfHandler(
        makeRequest({
            contentType: 'text/html; charset=utf-8',
            filename: '../../quarterly report.pdf',
            text: '<main>Quarterly report</main>',
        }),
        makeContext(),
        async (html) => {
            assert.equal(html, '<main>Quarterly report</main>');
            return Buffer.from('%PDF-1.7\n%%EOF\n');
        },
    );
    assert.equal(accepted.status, 200);
    assert.equal(
        accepted.headers['Content-Disposition'],
        'attachment; filename="quarterly-report.pdf"',
    );
});

test('oversized POST is rejected as a client warning', async () => {
    const context = makeContext();
    const response = await htmlToPdfHandler(
        makeRequest({ contentLength: MAX_HTML_BYTES + 1 }),
        context,
        async () => {
            throw new Error('renderer must not be called');
        },
    );

    assert.equal(response.status, 413);
    assert.equal(context.errors.length, 0);
    assert.equal(context.warnings.length, 1);
    assert.equal(context.warnings[0].details.code, 'HTML_TOO_LARGE');
});

test('default invoice contains no external resource references or scripts', () => {
    const html = defaultInvoiceHtml();
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']https?:/i);
});

test('documented sample HTML is bounded and self-contained', () => {
    const html = fs.readFileSync(
        path.resolve(__dirname, '..', 'sample.html'),
        'utf8',
    );

    assert.ok(Buffer.byteLength(html, 'utf8') <= MAX_HTML_BYTES);
    assert.match(html, /Azure Functions HTML-to-PDF/);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']https?:/i);
});
