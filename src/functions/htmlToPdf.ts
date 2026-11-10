import { app } from '@azure/functions';
import { htmlToPdfHandler } from '../pdf/httpHandler';

app.http('HtmlToPdf', {
    route: 'html-to-pdf',
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: htmlToPdfHandler,
});
