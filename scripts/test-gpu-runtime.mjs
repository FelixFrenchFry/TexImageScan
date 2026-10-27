import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { browserExecutable } from './browser.mjs';

const require = createRequire(import.meta.url);
const { build } = await import(
  pathToFileURL(createRequire(require.resolve('wxt')).resolve('vite')).href
);
const runtimeRequire = createRequire(require.resolve('@huggingface/transformers'));
const runtimeDirectory = dirname(runtimeRequire.resolve('onnxruntime-web'));
const output = resolve('.cache/gpu-runtime-regression');
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, 'index.html'),
  '<!doctype html><title>Real WebGPU runtime regression</title><script type="module" src="/runtime.mjs"></script>',
);
await build({
  configFile: false,
  logLevel: 'error',
  resolve: {
    alias: [
      { find: 'ort-runtime/', replacement: `${runtimeDirectory.replaceAll('\\', '/')}/` },
      {
        find: 'onnxruntime-web/webgpu',
        replacement: runtimeRequire.resolve('onnxruntime-web/webgpu'),
      },
    ],
  },
  build: {
    outDir: output,
    emptyOutDir: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: resolve('tests/fixtures/gpu-runtime.mjs'),
      output: { entryFileNames: 'runtime.mjs' },
    },
  },
});
const server = createServer(async (request, response) => {
  const path = resolve(output, '.' + new URL(request.url, 'http://localhost').pathname);
  if (!path.startsWith(output + sep)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const file = extname(path) ? path : resolve(path, 'index.html');
    const bytes = await readFile(file);
    response
      .writeHead(200, {
        'Content-Type':
          extname(file) === '.wasm'
            ? 'application/wasm'
            : extname(file) === '.mjs' || extname(file) === '.js'
              ? 'text/javascript'
              : 'text/html',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      })
      .end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
const diagnostics = [];
const report = { diagnostics, result: null, error: null };
try {
  // use the desktop GPU without the unsafe WebGPU override
  browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
  const page = await browser.newPage();
  page.on('console', (event) => {
    if (['warning', 'error'].includes(event.type())) diagnostics.push(event.text());
  });
  page.on('pageerror', (error) => diagnostics.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Log.enable');
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (['warning', 'error'].includes(entry.level)) diagnostics.push(entry.text);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => typeof window.runGpuRegression === 'function');
  report.result = await page.evaluate(() => window.runGpuRegression());
  assert.deepEqual(report.result.results, [
    [4, 6],
    [4, 6],
    [4, 6],
  ]);
  assert.equal(
    diagnostics.filter((message) => /powerPreference.*ignored/i.test(message)).length,
    0,
    'Real ONNX session creation still emits the Windows powerPreference warning',
  );
  if (process.platform === 'win32') {
    assert.ok(
      report.result.requests.every((options) => options.powerPreference === undefined),
      'The runtime made a Windows adapter request with a power hint',
    );
    assert.equal(
      report.result.requests.length,
      1,
      'All inference sessions must reuse the validated adapter/device',
    );
  }
  assert.ok(
    report.result.features.includes('shader-f16'),
    'Inference device must enable shader-f16',
  );
  console.log(JSON.stringify(report.result, null, 2));
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/gpu-runtime-regression.json', JSON.stringify(report, null, 2) + '\n');
}
