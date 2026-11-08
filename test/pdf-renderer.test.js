const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PdfRenderError,
  PdfRenderTimeoutError,
  renderHtmlToPdf,
} = require('../src/pdf-renderer');

function createPuppeteerDouble({
  setContentError,
  pdfResult = Buffer.from('%PDF-rendered'),
  pdfPromise,
} = {}) {
  const calls = {
    browserClosed: false,
    launchOptions: undefined,
    pageClosed: false,
    requestHandler: undefined,
  };

  const page = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async setJavaScriptEnabled(value) {
      calls.javascriptEnabled = value;
    },
    async setRequestInterception(value) {
      calls.requestInterception = value;
    },
    on(event, handler) {
      if (event === 'request') {
        calls.requestHandler = handler;
      }
    },
    async emulateMediaType(value) {
      calls.mediaType = value;
    },
    async setContent(html, options) {
      calls.html = html;
      calls.setContentOptions = options;
      if (setContentError) {
        throw setContentError;
      }
    },
    async pdf(options) {
      calls.pdfOptions = options;
      return pdfPromise ?? pdfResult;
    },
    async close() {
      calls.pageClosed = true;
    },
  };

  const browser = {
    async newPage() {
      return page;
    },
    async close() {
      calls.browserClosed = true;
    },
  };

  const puppeteer = {
    async launch(options) {
      calls.launchOptions = options;
      return browser;
    },
  };

  return { calls, puppeteer };
}

test('renderer uses the supplied Chromium, blocks network, and cleans up', async () => {
  const { calls, puppeteer } = createPuppeteerDouble();

  const pdf = await renderHtmlToPdf('<h1>Invoice</h1>', {
    puppeteer,
    executablePath: '/test/chromium',
    launchTimeoutMs: 100,
    renderTimeoutMs: 100,
    cleanupTimeoutMs: 100,
  });

  assert.equal(pdf.toString(), '%PDF-rendered');
  assert.equal(calls.launchOptions.executablePath, '/test/chromium');
  assert.equal(calls.launchOptions.headless, true);
  assert.equal(calls.launchOptions.timeout, 100);
  assert.ok(calls.launchOptions.args.includes('--no-sandbox'));
  assert.equal(calls.javascriptEnabled, false);
  assert.equal(calls.requestInterception, true);
  assert.equal(calls.mediaType, 'screen');
  assert.deepEqual(calls.setContentOptions, {
    waitUntil: 'domcontentloaded',
    timeout: 100,
  });
  assert.deepEqual(calls.pdfOptions, {
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });
  assert.equal(calls.pageClosed, true);
  assert.equal(calls.browserClosed, true);

  let blockedReason;
  await calls.requestHandler({
    url: () => 'https://169.254.169.254/latest/meta-data',
    continue: async () => assert.fail('External request must not continue'),
    abort: async (reason) => {
      blockedReason = reason;
    },
  });
  assert.equal(blockedReason, 'blockedbyclient');

  let continued = false;
  await calls.requestHandler({
    url: () => 'data:image/svg+xml;base64,PHN2Zy8+',
    continue: async () => {
      continued = true;
    },
    abort: async () => assert.fail('Data URL must be allowed'),
  });
  assert.equal(continued, true);
});

test('renderer closes resources when page setup fails', async () => {
  const { calls, puppeteer } = createPuppeteerDouble({
    setContentError: new Error('Invalid document'),
  });

  await assert.rejects(
    () => renderHtmlToPdf('<h1>Broken</h1>', {
      puppeteer,
      launchTimeoutMs: 100,
      renderTimeoutMs: 100,
      cleanupTimeoutMs: 100,
    }),
    PdfRenderError,
  );

  assert.equal(calls.pageClosed, true);
  assert.equal(calls.browserClosed, true);
});

test('renderer bounds PDF generation and still closes resources', async () => {
  const { calls, puppeteer } = createPuppeteerDouble({
    pdfPromise: new Promise(() => {}),
  });

  await assert.rejects(
    () => renderHtmlToPdf('<h1>Slow</h1>', {
      puppeteer,
      launchTimeoutMs: 100,
      renderTimeoutMs: 20,
      cleanupTimeoutMs: 100,
    }),
    PdfRenderTimeoutError,
  );

  assert.equal(calls.pageClosed, true);
  assert.equal(calls.browserClosed, true);
});
