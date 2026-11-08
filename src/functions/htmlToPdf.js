const { app } = require('@azure/functions');
const { htmlToPdfHandler } = require('../html-to-pdf-handler');

app.http('htmlToPdf', {
  route: 'html-to-pdf',
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: htmlToPdfHandler,
});
