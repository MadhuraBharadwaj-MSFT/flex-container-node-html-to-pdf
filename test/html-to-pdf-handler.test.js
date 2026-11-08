const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  MAX_HTML_BYTES,
  createHtmlToPdfHandler,
  readHtmlBody,
} = require('../src/html-to-pdf-handler');

function createContext() {
  const errors = [];
  const warnings = [];

  return {
    errors,
    warnings,
    error(...args) {
      errors.push(args);
    },
    warn(...args) {
      warnings.push(args);
    },
  };
}

test('GET renders the built-in invoice and returns a PDF attachment', async () => {
  let renderedHtml;
  const handler = createHtmlToPdfHandler({
    renderPdf: async (html) => {
      renderedHtml = html;
      return Buffer.from('%PDF-demo');
    },
  });

  const response = await handler(
    new Request('http://localhost/api/html-to-pdf'),
    createContext(),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'application/pdf');
  assert.equal(
    response.headers['Content-Disposition'],
    'attachment; filename="sample-invoice.pdf"',
  );
  assert.equal(response.body.toString(), '%PDF-demo');
  assert.match(renderedHtml, /Alpine Cloud Studio/);
  assert.match(renderedHtml, /DEMO-2026-001/);
});

test('POST renders a text/html body and uses a fixed safe filename', async () => {
  const html = '<!doctype html><h1>Customer document</h1>';
  let renderedHtml;
  const handler = createHtmlToPdfHandler({
    renderPdf: async (value) => {
      renderedHtml = value;
      return Buffer.from('%PDF-post');
    },
  });

  const response = await handler(
    new Request('http://localhost/api/html-to-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
    }),
    createContext(),
  );

  assert.equal(response.status, 200);
  assert.equal(renderedHtml, html);
  assert.equal(
    response.headers['Content-Disposition'],
    'attachment; filename="document.pdf"',
  );
});

test('POST rejects an empty HTML body', async () => {
  const handler = createHtmlToPdfHandler({
    renderPdf: async () => assert.fail('Renderer must not be called'),
  });

  const response = await handler(
    new Request('http://localhost/api/html-to-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: '   ',
    }),
    createContext(),
  );

  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, 'EMPTY_HTML');
});

test('POST rejects content types other than text/html', async () => {
  const handler = createHtmlToPdfHandler({
    renderPdf: async () => assert.fail('Renderer must not be called'),
  });

  const response = await handler(
    new Request('http://localhost/api/html-to-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"html":"<h1>Not accepted</h1>"}',
    }),
    createContext(),
  );

  assert.equal(response.status, 415);
  assert.equal(response.jsonBody.error.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('POST rejects an oversized Content-Length before reading the body', async () => {
  let bodyRead = false;
  const request = {
    method: 'POST',
    headers: new Headers({
      'Content-Type': 'text/html',
      'Content-Length': String(MAX_HTML_BYTES + 1),
    }),
    async text() {
      bodyRead = true;
      return '<h1>Too large</h1>';
    },
  };

  const handler = createHtmlToPdfHandler({
    renderPdf: async () => assert.fail('Renderer must not be called'),
  });
  const response = await handler(request, createContext());

  assert.equal(response.status, 413);
  assert.equal(response.jsonBody.error.code, 'HTML_TOO_LARGE');
  assert.equal(bodyRead, false);
});

test('body limits are measured in UTF-8 bytes', async () => {
  const request = new Request('http://localhost/api/html-to-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'text/html' },
    body: 'ééé',
  });

  await assert.rejects(
    () => readHtmlBody(request, 5),
    (error) => error.status === 413 && error.code === 'HTML_TOO_LARGE',
  );
});

test('renderer failures return a generic error and are logged', async () => {
  const context = createContext();
  const handler = createHtmlToPdfHandler({
    renderPdf: async () => {
      throw new Error('Chromium details that must not reach the caller');
    },
  });

  const response = await handler(
    new Request('http://localhost/api/html-to-pdf'),
    context,
  );

  assert.equal(response.status, 500);
  assert.equal(response.jsonBody.error.code, 'PDF_RENDER_FAILED');
  assert.equal(
    response.jsonBody.error.message,
    'The PDF could not be generated.',
  );
  assert.equal(context.errors.length, 1);
});

test('unsupported methods return 405 with an Allow header', async () => {
  const handler = createHtmlToPdfHandler();
  const response = await handler(
    {
      method: 'DELETE',
      headers: new Headers(),
    },
    createContext(),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.Allow, 'GET, POST');
});
