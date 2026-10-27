import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openExtension } from './browser.mjs';
import assert from 'node:assert/strict';

const manifest = JSON.parse(await readFile('src/model-manifest.json', 'utf8'));
const samples = JSON.parse(await readFile('tests/fixtures/samples/manifest.json', 'utf8'));
await mkdir('artifacts', { recursive: true });
await mkdir('test-results', { recursive: true });
const modelPrefix = `/${manifest.repository}/resolve/${manifest.revision}/`;
let assetRequests = 0;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const file = path.startsWith(modelPrefix)
    ? manifest.files.find((item) => path === modelPrefix + item.path)
    : undefined;
  if (!file || request.method !== 'GET') {
    response.writeHead(404).end();
    return;
  }
  assetRequests++;
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': file.size,
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  createReadStream(resolve('.model-cache', path.slice(1)))
    .on('error', () => response.destroy())
    .pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const build = spawnSync(process.execPath, ['node_modules/wxt/dist/cli/index.mjs', 'build'], {
  env: { ...process.env, WXT_MODEL_HOST: origin },
  encoding: 'utf8',
});
await writeFile('artifacts/benchmark-build.log', build.stdout + build.stderr);
if (build.status !== 0) {
  server.close();
  throw new Error('Benchmark build failed; see artifacts/benchmark-build.log');
}

const report = {
  date: new Date().toISOString(),
  model: manifest,
  browser: '',
  gpu: null,
  loadMs: null,
  assetMirrorUnavailable: false,
  networkDisabled: false,
  panelReopen: false,
  results: [],
  diagnostics: [],
  error: null,
};
let extension;
try {
  extension = await openExtension({
    directory: '.output/chrome-mv3-benchmark',
    profile: resolve('.cache/benchmark-profile'),
  });
  let page = extension.page;
  report.browser =
    extension.context.browser()?.version() ?? (await page.evaluate(() => navigator.userAgent));
  async function monitor(target) {
    await target.evaluate(() => {
      window.__ocrEvents = [];
      window.__ocrPort = chrome.runtime.connect({ name: 'teximagescan-panel' });
      window.__ocrPort.onMessage.addListener((state) => {
        window.__ocrState = state;
        window.__ocrEvents.push(state);
        if (window.__ocrEvents.length > 500) window.__ocrEvents.shift();
      });
    });
    await target.waitForFunction(() => window.__ocrState);
  }
  await page.waitForFunction(
    () => !document.body.innerText.includes('Connecting to local model host'),
  );
  await monitor(page);
  async function command(
    message,
    { closePanel = false, allowFailure = false, timeout = 300_000 } = {},
  ) {
    await page.evaluate((value) => {
      window.__ocrEvents = [];
      window.__ocrPort.postMessage(value);
    }, message);
    await page.waitForFunction(
      () => window.__ocrEvents.some((state) => state.job.kind === 'running'),
      null,
      { timeout: 10_000 },
    );
    if (closePanel) {
      await page.close();
      page = await extension.context.newPage();
      await page.goto(`chrome-extension://${extension.id}/sidepanel.html`);
      await page.waitForFunction(
        () => !document.body.innerText.includes('Connecting to local model host'),
      );
      await monitor(page);
      report.panelReopen = true;
    }
    let lastPhase = '';
    const progress = setInterval(async () => {
      const state = await page.evaluate(() => window.__ocrState).catch(() => null);
      const phase = state?.job.kind === 'running' ? `${state.job.phase}: ${state.job.detail}` : '';
      if (phase && phase !== lastPhase) {
        console.log(phase);
        lastPhase = phase;
      }
    }, 2000);
    try {
      await page.waitForFunction(() => window.__ocrState.job.kind !== 'running', null, { timeout });
      const state = await page.evaluate(() => window.__ocrState);
      if (state.job.kind === 'failed' && !allowFailure) throw new Error(state.job.message);
      return state;
    } finally {
      clearInterval(progress);
    }
  }
  const started = performance.now();
  console.log('Downloading verified assets and initializing the exact model…');
  const prepared = await command({ type: 'prepare' });
  report.loadMs = performance.now() - started;
  report.gpu = prepared.gpu;
  console.log(`Model ready on ${report.gpu}`);
  // stop the mirror after download to verify inference uses the cache
  await new Promise((resolve) => server.close(resolve));
  report.assetMirrorUnavailable = true;
  const selected = process.env.BENCHMARK_CASE
    ? samples.filter((sample) => sample.id === process.env.BENCHMARK_CASE)
    : samples;
  for (const [index, sample] of selected.entries()) {
    const image = `data:image/png;base64,${(await readFile(`tests/fixtures/samples/${sample.id}.png`)).toString('base64')}`;
    const state = await command(
      {
        type: 'recognize',
        image,
        name: `${sample.id}.png`,
        maxTokens: 1024,
        task: sample.kind === 'equation' ? 'equation' : 'mixed',
      },
      { closePanel: index === 0 },
    );
    const { image: _image, ...result } = state.result;
    report.results.push({
      sample: sample.id,
      kind: sample.kind,
      expected: sample.text,
      ...result,
      review: 'pending mathematical and textual review',
    });
    await writeFile('artifacts/benchmark.json', JSON.stringify(report, null, 2));
    console.log(
      `${sample.id}: ${(result.elapsedMs / 1000).toFixed(2)} s, ${result.tokenCount} tokens${result.truncated ? ' (TRUNCATED)' : ''}`,
    );
  }
  await page.screenshot({ path: 'artifacts/prototype-result.png', fullPage: true });
  if (!process.env.BENCHMARK_CASE) {
    for (const diagnostic of [
      { name: 'blank', file: 'blank', maxTokens: 64 },
      { name: 'token-limit', file: 'mixed-multiline', maxTokens: 32 },
    ]) {
      const image = `data:image/png;base64,${(await readFile(`tests/fixtures/samples/${diagnostic.file}.png`)).toString('base64')}`;
      const previousId = await page.evaluate(() => window.__ocrState.result.id);
      const state = await command(
        {
          type: 'recognize',
          image,
          name: `${diagnostic.name}.png`,
          maxTokens: diagnostic.maxTokens,
        },
        { allowFailure: diagnostic.name === 'blank' },
      );
      if (diagnostic.name === 'blank') {
        assert.equal(state.job.kind, 'failed');
        assert.match(state.job.message, /blank/);
        assert.equal(state.result.id, previousId);
        report.diagnostics.push({
          name: diagnostic.name,
          error: state.job.message,
          previousResultPreserved: true,
        });
        console.log(`blank: rejected; previous result preserved`);
        continue;
      }
      const { image: _image, ...result } = state.result;
      assert.equal(result.truncated, true);
      report.diagnostics.push({ name: diagnostic.name, ...result });
      console.log(
        `${diagnostic.name}: ${JSON.stringify(result.original)}, truncated=${result.truncated}`,
      );
    }
  }
  console.log(
    `Finished ${report.results.length} cases; ${assetRequests} asset requests; outputs in artifacts/benchmark.json`,
  );
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile('artifacts/benchmark.json', JSON.stringify(report, null, 2));
  await extension?.close();
  server.close();
}
