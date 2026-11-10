import {
    app,
    HttpRequest,
    HttpResponseInit,
    InvocationContext,
} from '@azure/functions';

export async function hello(
    _request: HttpRequest,
    _context: InvocationContext,
): Promise<HttpResponseInit> {
    return {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: 'Hello from the BYOC Node.js worker.',
    };
}

app.http('Hello', {
    route: 'hello',
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: hello,
});
