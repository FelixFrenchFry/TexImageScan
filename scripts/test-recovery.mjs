import { openSavedScan, editSource } from './lib/panel.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import manifest from '../src/model-manifest.json' with { type: 'json' };
import { openExtension, waitForPanel } from './browser.mjs';
import { serveModelMirror } from './lib/model-mirror.mjs';

// use the override as the parent directory for fresh profiles
const profileRoot = resolve(process.env.TEXIMAGESCAN_TEST_PROFILE ?? '.cache/recovery-profile');
await mkdir(profileRoot, { recursive: true });
const profile = await mkdtemp(join(profileRoot, 'run-'));
const reportPath = join(profile, 'recovery.json');
const report = { date: new Date().toISOString(), profile, checks: [], error: null };
let extension, mirror;
async function panel() {
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.id}/sidepanel.html`);
  await waitForPanel(page);
  await page.evaluate(() => {
    window.__recoveryEvents = [];
    window.__statePort = chrome.runtime.connect({ name: 'teximagescan-panel' });
    window.__statePort.onMessage.addListener((state) => {
      window.__state = state;
      window.__recoveryEvents.push(state);
      if (window.__recoveryEvents.length > 64) window.__recoveryEvents.shift();
    });
  });
  await page.waitForFunction(() => window.__state);
  return page;
}
async function send(page, command) {
  await page.evaluate((message) => {
    window.__recoveryEvents = [];
    window.__statePort.postMessage(message);
  }, command);
}
async function command(page, message, timeout = 180_000) {
  await send(page, message);
  await page.waitForFunction(() => window.__recoveryEvents.some((state) => state.job.kind === 'running'));
  await page.waitForFunction(() => window.__state.job.kind !== 'running', null, { timeout });
  const state = await page.evaluate(() => window.__state);
  assert.equal(state.job.kind, 'idle', state.job.message);
  return state;
}
function assertEquation(result) {
  assert.equal(result.modelRevision, manifest.revision);
  assert.equal(result.mode, 'equation');
  assert.equal(result.truncated, false);
  assert.match(result.original, /E\s*=\s*m\s*c\^(?:2|\{2\})/);
}
try {
  // require local assets before launching Chrome
  for (const file of manifest.files) {
    const path = resolve('.model-cache', manifest.repository, 'resolve', manifest.revision, file.path);
    const cached = await stat(path).catch((error) => {
      throw new Error(`Local model asset unavailable: ${file.path}. Run pnpm model:download first.`, { cause: error });
    });
    assert.equal(cached.size, file.size, `Invalid local asset ${file.path}; run pnpm model:download`);
  }
  const image = `data:image/png;base64,${(await readFile('tests/fixtures/samples/energy.png')).toString('base64')}`;
  // let openExtension select the build and apply TEXIMAGESCAN_TEST_BUILD
  extension = await openExtension({ profile });
  let page = await panel();
  await extension.page.close();
  assert.equal(await page.evaluate(() => window.__state.history.length), 0);
  report.extensionId = extension.id;
  mirror = await serveModelMirror(extension.context, manifest);
  // Playwright cannot route offscreen requests on every Chrome version
  // seed raw bytes without a completion marker so production preparation verifies them
  await page.evaluate(async ({ manifest, origin }) => {
    const cache = await caches.open(`teximagescan-model-${manifest.revision}`);
    const prefix = `/${manifest.repository}/resolve/${manifest.revision}/`;
    for (const file of manifest.files) {
      const response = await fetch(origin + prefix + file.path);
      if (!response.ok) throw new Error(`Local mirror failed: ${file.path}`);
      await cache.put(`https://huggingface.co${prefix}${file.path}`, response);
    }
  }, { manifest, origin: mirror.origin });
  report.mirrorRequests = mirror.requests;
  await mirror.close();
  mirror = undefined;
  await extension.context.setOffline(true);
  report.offlineBeforePreparation = true;
  const prepared = await command(page, { type: 'prepare' }, 600_000);
  assert.equal(prepared.model, 'ready');
  const seeded = await command(page, { type: 'recognize', name: 'recovery-energy.png', image, maxTokens: 256 });
  assertEquation(seeded.result);
  assert.ok(seeded.history.some((scan) => scan.id === seeded.result.id));
  const previous = seeded.result;
  report.checks.push('Fresh profile prepared the pinned local model and saved a real equation offline');

  await extension.close();
  extension = undefined;
  extension = await openExtension({ profile });
  await extension.context.setOffline(true);
  page = await panel();
  await extension.page.close();
  assert.equal(await page.evaluate(() => window.__state.model), 'cached');
  assert.deepEqual(await page.evaluate(() => window.__state.result), previous);
  report.checks.push('Completed result survived browser restart');
  await openSavedScan(page, previous.name, previous.id);
  await editSource(page);
  await page.getByLabel('Editable source').fill('$x = 123$');
  await page.waitForFunction(() => window.__state.result.edited === '$x = 123$');
  await page.close();
  page = await panel();
  await openSavedScan(page, previous.name, previous.id);
  await editSource(page);
  assert.equal(await page.getByLabel('Editable source').inputValue(), '$x = 123$');
  report.checks.push('Edits survived panel closure and reopening');

  // use a different equation to show the previous result while the worker loads
  const cancelImage = `data:image/png;base64,${(await readFile('tests/fixtures/samples/integral.png')).toString('base64')}`;
  await send(page, { type: 'recognize', name: 'cancel.png', image: cancelImage, maxTokens: 256 });
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
  assert.equal(cancelled.history.length, seeded.history.length);
  report.checks.push(
    'Cancellation terminated the worker and preserved edits; host rejected edits while busy',
  );

  const recovered = await command(page, { type: 'recognize', name: 'cache-reload.png', image, maxTokens: 256 });
  assert.notEqual(recovered.result.id, previous.id);
  assertEquation(recovered.result);
  assert.equal(recovered.history.length, seeded.history.length + 1);
  assert.ok(recovered.history.some((scan) => scan.id === previous.id));
  report.checks.push(
    'Fresh worker recognized an equation from cache with networking disabled and the mirror stopped',
  );

  const cdp = await extension.context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
  await page.reload();
  await waitForPanel(page);
  await openSavedScan(page, recovered.result.name, recovered.result.id);
  await editSource(page);
  await page.getByLabel('Editable source').waitFor();
  await editSource(page);
  assert.equal(await page.getByLabel('Editable source').inputValue(), recovered.result.edited);
  report.checks.push('Result survived background service-worker stop and panel reload');
  await page.screenshot({ path: join(profile, 'recovered.png'), fullPage: true });
  console.log(report.checks.join('\n'));
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  try { await mirror?.close(); }
  finally {
    try { await extension?.close(); }
    finally {
      report.finishedAt = new Date().toISOString();
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(`Recovery report: ${reportPath}`);
    }
  }
}
