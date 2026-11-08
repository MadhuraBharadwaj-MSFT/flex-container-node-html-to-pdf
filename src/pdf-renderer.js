const puppeteerCore = require('puppeteer-core');

const DEFAULT_CHROMIUM_PATH = '/usr/bin/chromium';
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_RENDER_TIMEOUT_MS = 20_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

class PdfRenderError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PdfRenderError';
  }
}

class PdfRenderTimeoutError extends PdfRenderError {
  constructor(operation, timeoutMs) {
    super(`${operation} exceeded the ${timeoutMs} ms timeout.`);
    this.name = 'PdfRenderTimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

function withTimeout(operation, timeoutMs, operationName) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new PdfRenderTimeoutError(operationName, timeoutMs)),
      timeoutMs,
    );
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    clearTimeout(timeout);
  });
}

function isAllowedResourceUrl(url) {
  return (
    url === 'about:blank'
    || url.startsWith('data:')
    || url.startsWith('blob:')
  );
}

function warn(logger, message, error) {
  logger?.warn?.(message, error);
}

function createRequestHandler(logger) {
  return async function handleRequest(request) {
    try {
      if (isAllowedResourceUrl(request.url())) {
        await request.continue();
        return;
      }

      await request.abort('blockedbyclient');
    } catch (error) {
      warn(logger, 'Failed to resolve a Chromium subresource request.', error);
    }
  };
}

async function closeResource(resource, name, timeoutMs, logger) {
  if (!resource) {
    return;
  }

  try {
    await withTimeout(
      Promise.resolve(resource.close()),
      timeoutMs,
      `${name} cleanup`,
    );
  } catch (error) {
    warn(logger, `Failed to close the Chromium ${name}.`, error);
  }
}

async function renderHtmlToPdf(
  html,
  {
    puppeteer = puppeteerCore,
    executablePath = process.env.CHROMIUM_PATH || DEFAULT_CHROMIUM_PATH,
    launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
    renderTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    logger,
  } = {},
) {
  let browser;
  let page;

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      timeout: launchTimeoutMs,
      protocolTimeout: renderTimeoutMs,
      args: [
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-sandbox',
      ],
    });

    page = await browser.newPage();
    page.setDefaultTimeout(renderTimeoutMs);
    page.setDefaultNavigationTimeout(renderTimeoutMs);
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', createRequestHandler(logger));
    await page.emulateMediaType('screen');
    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
      timeout: renderTimeoutMs,
    });

    const pdf = await withTimeout(
      page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
      }),
      renderTimeoutMs,
      'PDF generation',
    );

    return Buffer.from(pdf);
  } catch (error) {
    if (error instanceof PdfRenderError) {
      throw error;
    }

    throw new PdfRenderError(
      'Chromium could not render the HTML document.',
      { cause: error },
    );
  } finally {
    await closeResource(page, 'page', cleanupTimeoutMs, logger);
    await closeResource(browser, 'browser', cleanupTimeoutMs, logger);
  }
}

module.exports = {
  DEFAULT_CHROMIUM_PATH,
  PdfRenderError,
  PdfRenderTimeoutError,
  createRequestHandler,
  isAllowedResourceUrl,
  renderHtmlToPdf,
  withTimeout,
};
