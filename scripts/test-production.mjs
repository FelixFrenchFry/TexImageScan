import {
  openSettings,
  openHistory,
  openSavedScan,
  backToScan,
  editSource,

  startRecognition,
} from './lib/panel.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openExtension } from './browser.mjs';
import { serveModelMirror } from './lib/model-mirror.mjs';

await mkdir('artifacts', { recursive: true });
const report = {
  date: new Date().toISOString(),
  browser: '',
  gpu: null,
  unsafeWebgpuFlag: false,
  prepareMs: null,
  checks: [],
  error: null,
};
let extension, mirror;
let progress;
try {
  // use production permissions and model URLs without WebGPU overrides
  extension = await openExtension({
    profile: resolve(process.env.TEXIMAGESCAN_TEST_PROFILE ?? '.cache/production-profile'),
  });
  const { page, context } = extension;
  mirror = await serveModelMirror(context, JSON.parse(await readFile('src/model-manifest.json')));
  report.browser = context.browser()?.version() ?? '';
  await page.waitForFunction(
    () => !document.body.innerText.includes('Connecting to local model host'),
  );
  await page.evaluate(() => {
    window.__port = chrome.runtime.connect({ name: 'teximagescan-panel' });
    window.__port.onMessage.addListener((state) => {
      window.__state = state;
    });
  });
  await page.waitForFunction(() => window.__state);
  let last = '';
  progress = setInterval(async () => {
    const detail = await page.evaluate(() => window.__state.job.detail ?? '').catch(() => '');
    if (detail && detail !== last) {
      console.log(detail);
      last = detail;
    }
  }, 2000);
  const start = performance.now();
  if (await page.evaluate(() => window.__state.model === 'missing')) {
    await page.getByRole('button', { name: /Download model/ }).click();
    await page.waitForFunction(() => window.__state.job.kind === 'running');
    await page.waitForFunction(() => window.__state.job.kind !== 'running', null, {
      timeout: 600_000,
    });
  }
  const prepared = await page.evaluate(() => window.__state);
  // a reused profile can retain a cancelled or interrupted previous operation
  assert.notEqual(prepared.job.kind, 'running', prepared.job.message);
  assert.ok(['ready', 'cached'].includes(prepared.model));
  report.prepareMs = performance.now() - start;
  report.gpu = prepared.gpu;
  report.mirrorRequests = mirror.requests;
  await mirror.close();
  mirror = undefined;
  report.checks.push(
    'Production model files are available without a WebGPU override; recognition loads cached files automatically',
  );

  await openSettings(page);

  await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/energy.png');
  await page
    .getByRole('region', { name: 'Source image', exact: true })
    .getByRole('img', { name: 'Source: energy.png' })
    .waitFor();
  page.on('dialog', (dialog) => dialog.accept());
  await startRecognition(page);
  await page.waitForFunction(() => window.__state.job.kind === 'running');
  await page.waitForFunction(() => window.__state.job.kind !== 'running', null, {
    timeout: 180_000,
  });
  const result = await page.evaluate(() => window.__state);
  assert.equal(result.job.kind, 'idle', result.job.message);
  assert.match(result.result.original, /E\s*=\s*m\s*c\^(?:2|\{2\})/);
  await editSource(page);
  await page.getByLabel('Editable source').fill('$E=mc^2$');
  await page.waitForFunction(() => window.__state.result.edited === '$E=mc^2$');
  await page.getByRole('button', { name: 'Copy Markdown with math', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Copied Markdown' }).waitFor();
  report.checks.push(
    'Image upload, recognition, editing, persistence acknowledgement, and clipboard write succeeded through the UI',
  );

  await page
    .getByLabel('Choose image file')
    .setInputFiles('tests/fixtures/generated/bold-vectors.png');
  await page
    .getByRole('region', { name: 'Source image', exact: true })
    .getByRole('img', { name: 'Source: bold-vectors.png' })
    .waitFor();
  await startRecognition(page);
  await page.waitForFunction(() => window.__state.job.kind === 'running');
  await page.waitForFunction(() => window.__state.job.kind !== 'running', null, {
    timeout: 180_000,
  });
  const vector = await page.evaluate(() => window.__state);
  assert.equal(vector.job.kind, 'idle', vector.job.message);
  assert.equal((vector.result.original.match(/\\(?:boldsymbol|mathbf)\{x\}/g) ?? []).length, 4);
  report.checks.push(
    'Formula recognition retained all four bold vectors in the generated vector fixture',
  );
  await page.screenshot({ path: 'artifacts/production-smoke.png', fullPage: true });

  assert.equal(vector.result.mode, 'equation');
  assert.equal(typeof vector.result.raw, 'string');
  for (const scan of [result, vector])
    assert.ok(vector.history.some((entry) => entry.id === scan.result.id));
  await openHistory(page);
  await page.getByRole('button', { name: 'Open energy.png', exact: true }).first().click();
  await page.waitForFunction((id) => window.__state.result.id === id, result.result.id);
  await editSource(page);
  await page.getByLabel('Editable source').fill('$E = mc^2$');
  await page.waitForFunction(() => window.__state.result.edited === '$E = mc^2$');
  await openHistory(page);
  await page
    .getByRole('region', { name: 'Scan history' })
    .screenshot({ path: 'artifacts/history-production.png' });
  await page.evaluate(() => chrome.offscreen.closeDocument());
  await page.reload();
  await openSavedScan(page, 'energy.png');
  await editSource(page);
  assert.equal(await page.getByLabel('Editable source').inputValue(), '$E = mc^2$');
  await openHistory(page);
  await page.getByRole('button', { name: 'Open bold-vectors.png', exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Open energy.png', exact: true }).first().waitFor();
  report.checks.push(
    'Three real recognitions entered history; an older scan reopened and edited, and history survived host restart',
  );
  console.log(report.checks.join('\n'));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  clearInterval(progress);
  await mirror?.close();
  await extension?.close();
  await writeFile('artifacts/production.json', JSON.stringify(report, null, 2));
}
