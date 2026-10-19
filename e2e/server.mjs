import { createServer } from 'node:http';

// One server for every test origin. The browser maps *.test to 127.0.0.1, so the Host header tells
// the sites apart: app.test and evil.test serve blank pages, and api.test is an API that never sends
// CORS headers itself, so any cross-origin read succeeding proves the extension added them.
export async function startTestServer() {
  const server = createServer((request, response) => {
    const host = (request.headers.host ?? '').split(':')[0];
    if (host === 'api.test') {
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'x-api-version': '1' });
      response.end(JSON.stringify({ ok: true, method: request.method, path: request.url }));
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>${host}</title>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    origin: (host) => `http://${host}:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
