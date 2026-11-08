const { renderHtmlToPdf } = require('./pdf-renderer');
const { buildSampleInvoiceHtml } = require('./sample-invoice');

const MAX_HTML_BYTES = 512 * 1024;
const PDF_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Type': 'application/pdf',
  'X-Content-Type-Options': 'nosniff',
});
const JSON_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
});

class RequestValidationError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = 'RequestValidationError';
    this.status = status;
    this.code = code;
  }
}

function getHeader(request, name) {
  return request.headers?.get?.(name) ?? undefined;
}

function isHtmlContentType(contentType) {
  return /^\s*text\/html\s*(?:;|$)/i.test(contentType ?? '');
}

function parseContentLength(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new RequestValidationError(
      400,
      'INVALID_CONTENT_LENGTH',
      'The Content-Length header must be a non-negative integer.',
    );
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RequestValidationError(
      400,
      'INVALID_CONTENT_LENGTH',
      'The Content-Length header is too large to process safely.',
    );
  }

  return parsed;
}

function oversizedBodyError(maxHtmlBytes) {
  return new RequestValidationError(
    413,
    'HTML_TOO_LARGE',
    `The HTML body exceeds the ${maxHtmlBytes}-byte limit.`,
  );
}

async function readHtmlBody(request, maxHtmlBytes = MAX_HTML_BYTES) {
  const contentType = getHeader(request, 'content-type');
  if (!isHtmlContentType(contentType)) {
    throw new RequestValidationError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'POST requests must use Content-Type: text/html.',
    );
  }

  const contentLength = parseContentLength(getHeader(request, 'content-length'));
  if (contentLength !== undefined && contentLength > maxHtmlBytes) {
    throw oversizedBodyError(maxHtmlBytes);
  }

  let html;
  try {
    html = await request.text();
  } catch (error) {
    throw new RequestValidationError(
      400,
      'INVALID_HTML_BODY',
      'The HTML request body could not be read.',
      { cause: error },
    );
  }

  if (Buffer.byteLength(html, 'utf8') > maxHtmlBytes) {
    throw oversizedBodyError(maxHtmlBytes);
  }

  if (html.trim().length === 0) {
    throw new RequestValidationError(
      400,
      'EMPTY_HTML',
      'The HTML request body must not be empty.',
    );
  }

  return html;
}

function errorResponse(status, code, message, extraHeaders = {}) {
  return {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders,
    },
    jsonBody: {
      error: {
        code,
        message,
      },
    },
  };
}

function pdfResponse(pdf, filename) {
  return {
    status: 200,
    headers: {
      ...PDF_HEADERS,
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
    body: pdf,
  };
}

function createHtmlToPdfHandler({
  renderPdf = renderHtmlToPdf,
  sampleInvoice = buildSampleInvoiceHtml,
  maxHtmlBytes = MAX_HTML_BYTES,
} = {}) {
  return async function htmlToPdfHandler(request, context) {
    const method = (request.method ?? '').toUpperCase();

    try {
      if (method === 'GET') {
        const pdf = await renderPdf(sampleInvoice(), { logger: context });
        return pdfResponse(pdf, 'sample-invoice.pdf');
      }

      if (method === 'POST') {
        const html = await readHtmlBody(request, maxHtmlBytes);
        const pdf = await renderPdf(html, { logger: context });
        return pdfResponse(pdf, 'document.pdf');
      }

      return errorResponse(
        405,
        'METHOD_NOT_ALLOWED',
        'Only GET and POST are supported.',
        { Allow: 'GET, POST' },
      );
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return errorResponse(error.status, error.code, error.message);
      }

      context?.error?.('HTML-to-PDF rendering failed.', error);
      return errorResponse(
        500,
        'PDF_RENDER_FAILED',
        'The PDF could not be generated.',
      );
    }
  };
}

const htmlToPdfHandler = createHtmlToPdfHandler();

module.exports = {
  MAX_HTML_BYTES,
  RequestValidationError,
  createHtmlToPdfHandler,
  htmlToPdfHandler,
  isHtmlContentType,
  readHtmlBody,
};
