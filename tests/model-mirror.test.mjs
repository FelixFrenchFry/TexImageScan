import { expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { browserExecutable } from '../scripts/browser.mjs';
import { serveModelMirror } from '../scripts/lib/model-mirror.mjs';

it('redirects pinned browser requests to streamed local files and rejects unlisted files', async () => {
  await mkdir('test-results', { recursive: true });
  const directory = await mkdtemp(resolve('test-results/model-mirror-'));
  const manifest = {
    repository: 'test/model', revision: 'test-revision',
    files: [{ path: 'weights.bin', size: 5 }],
  };
  await mkdir(join(directory, 'test/model/resolve/test-revision'), { recursive: true });
  await writeFile(join(directory, 'test/model/resolve/test-revision/weights.bin'), 'model');
  const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
  let mirror;
  try {
    const context = await browser.newContext();
    mirror = await serveModelMirror(context, manifest, { cacheDirectory: directory });
    const page = await context.newPage();
    await context.route(mirror.origin + '/', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Mirror test</title>' }));
    await page.goto(mirror.origin);
    const response = await page.evaluate(async () => {
      const response = await fetch('https://huggingface.co/test/model/resolve/test-revision/weights.bin');
      return { status: response.status, text: await response.text(), length: response.headers.get('content-length') };
    });
    expect(response).toEqual({ status: 200, text: 'model', length: '5' });
    expect(mirror.requests).toBe(1);
    expect((await fetch(mirror.origin + '/test/model/resolve/test-revision/unlisted.bin')).status).toBe(404);
  } finally {
    await mirror?.close();
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
