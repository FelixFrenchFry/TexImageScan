import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

// stream local assets through a redirect to avoid buffering whole model files in Playwright
export async function serveModelMirror(context, manifest, { cacheDirectory = '.model-cache' } = {}) {
  const prefix = `/${manifest.repository}/resolve/${manifest.revision}/`;
  let requests = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = manifest.files.find((file) => path === prefix + file.path);
    if (request.method !== 'GET' || !file) {
      response.writeHead(404).end();
      return;
    }
    requests++;
    response.writeHead(200, {
      'Content-Length': file.size,
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(resolve(cacheDirectory, path.slice(1)))
      .on('error', () => response.destroy())
      .pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pattern = `https://huggingface.co${prefix}**`;
  const redirect = (route) => route.fulfill({
    status: 307,
    headers: {
      location: origin + new URL(route.request().url()).pathname,
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
    },
    body: '',
  });
  try {
    await context.route(pattern, redirect);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    origin,
    get requests() { return requests; },
    async close() {
      await context.unroute(pattern, redirect);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
