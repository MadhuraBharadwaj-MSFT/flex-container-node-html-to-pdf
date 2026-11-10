const { app } = require('@azure/functions');

app.http('Hello', {
    route: 'hello',
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async () => ({
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: 'Hello from the BYOC Node.js worker.',
    }),
});
