import {
    PdfRenderError,
    defaultInvoiceHtml,
    readHtmlRequest,
    renderHtmlToPdf,
    safePdfFilename,
} from './renderPdf';
import {
    HttpRequest,
    HttpResponseInit,
    InvocationContext,
} from '@azure/functions';

export type PdfRenderer = (html: string) => Promise<Buffer>;

export function errorResponse(status: number, message: string): HttpResponseInit {
    return {
        status,
        headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
        },
        body: message,
    };
}

export async function htmlToPdfHandler(
    request: HttpRequest,
    context: InvocationContext,
    renderer: PdfRenderer = renderHtmlToPdf,
): Promise<HttpResponseInit> {
    let html: string;
    let filename: string;

    try {
        if (request.method === 'GET') {
            html = defaultInvoiceHtml();
            filename = 'invoice.pdf';
        } else {
            const contentType = (request.headers.get('content-type') || '')
                .split(';', 1)[0]
                .trim()
                .toLowerCase();
            if (contentType !== 'text/html') {
                return errorResponse(415, 'POST requires Content-Type: text/html.');
            }

            html = await readHtmlRequest(request);
            filename = safePdfFilename(request.headers.get('x-pdf-filename'), 'document');
        }

        const pdf = await renderer(html);
        return {
            status: 200,
            headers: {
                'Cache-Control': 'no-store',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Length': String(pdf.length),
                'Content-Type': 'application/pdf',
                'X-Content-Type-Options': 'nosniff',
            },
            body: pdf,
        };
    } catch (error: unknown) {
        const normalized =
            error instanceof PdfRenderError
                ? error
                : new PdfRenderError('UNEXPECTED_ERROR', 'PDF rendering failed.', 500);
        if (!(error instanceof PdfRenderError)) {
            normalized.cause = error;
        }

        if (normalized.status >= 500) {
            const causeMessage =
                normalized.cause instanceof Error
                    ? normalized.cause.message
                    : undefined;
            context.error('HTML-to-PDF request failed.', {
                code: normalized.code,
                message: normalized.message,
                cause: causeMessage,
                stack: error instanceof Error ? error.stack : undefined,
            });
        } else {
            context.warn('HTML-to-PDF request rejected.', {
                code: normalized.code,
                message: normalized.message,
            });
        }
        return errorResponse(normalized.status, normalized.message);
    }
}
