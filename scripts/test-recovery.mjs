import { openSavedScan, editSource } from './lib/panel.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openExtension, waitForPanel } from './browser.mjs';

await mkdir('artifacts', { recursive: true });
const report = { date: new Date().toISOString(), checks: [], error: null };
let extension;
async function panel() {
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.id}/sidepanel.html`);
  await waitForPanel(page);
  await page.evaluate(() => {
    window.__statePort = chrome.runtime.connect({ name: 'teximagescan-panel' });
    window.__statePort.onMessage.addListener((state) => {
      window.__state = state;
    });
  });
  await page.waitForFunction(() => window.__state);
  return page;
}
async function send(page, command) {
  await page.evaluate((message) => {
    window.__statePort.postMessage(message);
  }, command);
}
try {
  extension = await openExtension({
    directory: '.output/chrome-mv3-benchmark',
    profile: resolve('.cache/benchmark-profile'),
  });
  let page = await panel();
  await extension.page.close();
  assert.equal(await page.evaluate(() => window.__state.model), 'cached');
  const previous = await page.evaluate(() => window.__state.result);
  assert.ok(previous);
  report.checks.push('Completed result survived browser restart');
  await openSavedScan(page, previous.name);
  await editSource(page);
  await page.getByLabel('Editable source').fill('$x = 123$');
  await page.waitForFunction(() => window.__state.result.edited === '$x = 123$');
  await page.close();
  page = await panel();
  await openSavedScan(page, previous.name);
  await editSource(page);
  assert.equal(await page.getByLabel('Editable source').inputValue(), '$x = 123$');
  report.checks.push('Edits survived panel closure and reopening');

  const image = `data:image/png;base64,${(await readFile('tests/fixtures/samples/mixed-multiline.png')).toString('base64')}`;
  await send(page, { type: 'recognize', name: 'cancel.png', image, maxTokens: 4096 });
  await page.waitForFunction(() => window.__state.job.kind === 'running');
  const previousResult = page.getByRole('region', { name: 'Previous result', exact: true });
  await previousResult.waitFor();
  assert.equal(await previousResult.locator('.previous-excerpt').innerText(), '$x = 123$');
  await send(page, {
    type: 'save',
    id: previous.id,
    text: 'must not replace saved edits while recognizing',
  });
  await send(page, { type: 'cancel' });
  await page.waitForFunction(() => window.__state.job.kind === 'cancelled');
  const cancelled = await page.evaluate(() => window.__state);
  assert.equal(cancelled.result.id, previous.id);
  assert.equal(cancelled.result.edited, '$x = 123$');
  report.checks.push(
    'Cancellation terminated the worker and preserved edits; host rejected edits while busy',
  );

  // a fresh worker must use the cache after the asset mirror stops
  await send(page, { type: 'recognize', name: 'cache-reload.png', image, maxTokens: 1024 });
  await page.waitForFunction(() => window.__state.job.kind === 'running');
  await page.waitForFunction(() => window.__state.job.kind !== 'running', null, {
    timeout: 180_000,
  });
  const recovered = await page.evaluate(() => window.__state);
  assert.equal(recovered.job.kind, 'idle', recovered.job.message);
  assert.notEqual(recovered.result.id, previous.id);
  assert.match(recovered.result.original, /acceleration/);
  report.checks.push(
    'Fresh worker loaded cached model and recognized mixed content with the asset mirror unavailable',
  );

  const cdp = await extension.context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.reload();
  await openSavedScan(page, recovered.result.name);
  await editSource(page);
  await page.getByLabel('Editable source').waitFor();
  await editSource(page);
  assert.equal(await page.getByLabel('Editable source').inputValue(), recovered.result.edited);
  report.checks.push('Result survived background service-worker stop and panel reload');
  await page.screenshot({ path: 'artifacts/prototype-recovered.png', fullPage: true });
  console.log(report.checks.join('\n'));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await extension?.close();
  await writeFile('artifacts/recovery.json', JSON.stringify(report, null, 2));
}
