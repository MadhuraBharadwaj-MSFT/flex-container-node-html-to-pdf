const { app } = require('@azure/functions');
const { htmlToPdfHandler } = require('../pdf/httpHandler');

app.http('HtmlToPdf', {
    route: 'html-to-pdf',
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: htmlToPdfHandler,
});
