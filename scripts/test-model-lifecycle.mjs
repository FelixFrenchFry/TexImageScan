import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { openExtension, waitForPanel } from './browser.mjs';

await mkdir('artifacts', { recursive: true });
const report = { checks: [], result: null, runtimeErrors: [], error: null };
let extension;
const warningProbe = resolve('.output/chrome-mv3/gpu-warning-negative-control.js');
async function observe(page) {
  await page.evaluate(() => {
    window.__modelEvents = [];
    window.__modelPort = chrome.runtime.connect({ name: 'teximagescan-panel' });
    window.__modelPort.onMessage.addListener((state) => {
      window.__modelState = state;
      window.__modelEvents.push(state);
    });
  });
  await page.waitForFunction(() => window.__modelState);
}
try {
  // reuse the isolated verification profile and its model cache

  extension = await openExtension({ profile: resolve('.cache/production-profile'), gpu: false });
  let { page } = extension;
  // inspect Chrome extension errors, including native ONNX worker warnings

  const inspector = await extension.context.newPage();
  await inspector.goto('chrome://extensions/');
  await inspector.evaluate(async (id) => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
    await chrome.developerPrivate.updateExtensionConfiguration({
      extensionId: id,
      errorCollection: true,
    });
  }, extension.id);
  const readErrors = () =>
    inspector.evaluate(async (id) => {
      const infos = await new Promise((resolve) =>
        chrome.developerPrivate.getExtensionsInfo(
          { includeDisabled: true, includeTerminated: true },
          resolve,
        ),
      );
      const info = infos.find((info) => info.id === id);
      if (!info?.errorCollection.isActive)
        throw new Error('Chrome extension error collection is inactive');
      return info.runtimeErrors;
    }, extension.id);
  // verify the monitor catches the warning before clearing it and running recognition

  if (process.platform === 'win32') {
    // Chrome attributes warnings to packaged scripts rather than DevTools evaluations
    // remove the probe before exiting
    await writeFile(
      warningProbe,
      'void navigator.gpu.requestAdapter({powerPreference:"high-performance"});\n',
    );
    await page.addScriptTag({
      url: `chrome-extension://${extension.id}/gpu-warning-negative-control.js`,
    });
    await expect
      .poll(async () =>
        (await readErrors()).some((error) => /powerPreference.*ignored/i.test(error.message)),
      )
      .toBe(true);
  }
  await inspector.evaluate(
    (id) => chrome.developerPrivate.deleteExtensionErrors({ extensionId: id }),
    extension.id,
  );
  await observe(page);
  assert.equal(
    await page.evaluate(() => window.__modelState.model),
    'cached',
    'This check requires previously downloaded model files',
  );
  assert.equal(await page.getByRole('region', { name: 'Model setup' }).count(), 0);
  await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/energy.png');
  await page.getByRole('button', { name: 'Recognize image', exact: true }).click();
  await page.waitForFunction(() =>
    window.__modelEvents.some(
      (state) => state.job.kind === 'running' && state.job.phase === 'loading',
    ),
  );
  report.checks.push('Recognize image started loading cached files without a preload control');
  await page.close();
  page = await extension.context.newPage();
  await page.goto('chrome-extension://' + extension.id + '/sidepanel.html');
  await observe(page);
  await page.waitForFunction(() => window.__modelState.job.kind !== 'running', null, {
    timeout: 180_000,
  });
  await waitForPanel(page);
  const state = await page.evaluate(() => window.__modelState);
  assert.equal(state.job.kind, 'idle', state.job.message);
  assert.equal(state.model, 'ready');
  assert.equal(state.result.name, 'energy.png');
  assert.match(state.result.original, /E\s*=\s*mc\^(?:2|\{2\})/);
  report.runtimeErrors = await readErrors();
  assert.equal(
    report.runtimeErrors.filter((error) => /powerPreference.*ignored/i.test(error.message)).length,
    0,
    'Production ONNX model loading emitted the Windows powerPreference warning',
  );
  report.checks.push(
    'Chrome recorded the deliberate negative-control warning, then recorded no powerPreference warning during real OCR model loading',
  );
  report.checks.push(
    'Closing the panel during loading preserved recognition and its completed result',
  );
  assert.equal(await page.getByRole('region', { name: 'Model setup' }).count(), 0);
  await page.screenshot({ path: 'artifacts/automatic-model-loading.png', fullPage: true });
  report.result = {
    original: state.result.original,
    elapsedMs: state.result.elapsedMs,
    gpu: state.result.gpu,
  };
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await extension?.close();
  await rm(warningProbe, { force: true });
  await writeFile('artifacts/automatic-model-loading.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
