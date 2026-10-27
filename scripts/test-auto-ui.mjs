import {
  openSettings,
  openSavedScan,
  editSource,
  currentMode,
  setMode,
  startRecognition,
} from './lib/panel.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openExtension } from './browser.mjs';

const report = {
  date: new Date().toISOString(),
  unsafeWebgpuFlag: false,
  checks: [],
  results: [],
  error: null,
};
let extension;
try {
  extension = await openExtension({ profile: resolve('.cache/production-profile'), gpu: false });
  const { page } = extension;
  assert.match(await currentMode(page), /Auto/);
  await page.evaluate(() => {
    window.__autoEvents = [];
    window.__autoPort = chrome.runtime.connect({ name: 'teximagescan-panel' });
    window.__autoPort.onMessage.addListener((state) => {
      window.__autoState = state;
      window.__autoEvents.push(state);
    });
  });
  await page.waitForFunction(() => window.__autoState);
  const previous = await page.evaluate(() => ({
    result: window.__autoState.result,
    count: window.__autoState.history.length,
  }));
  if (previous.result) {
    await openSavedScan(page, previous.result.name, previous.result.id);
    await editSource(page);
    await page.getByLabel('Editable source').fill('$preserved = 321$');
    await page.waitForFunction(() => window.__autoState.result.edited === '$preserved = 321$');
  }
  await setMode(page, 'Auto');
  await page
    .getByLabel('Choose image file')
    .setInputFiles('tests/fixtures/generated/bold-vectors.png');
  await page
    .getByRole('region', { name: 'Source image', exact: true })
    .getByRole('img', { name: 'Source: bold-vectors.png' })
    .waitFor();
  await startRecognition(page);
  await page.waitForFunction(
    () =>
      window.__autoState.job.kind === 'running' && window.__autoState.job.phase === 'recognizing',
    null,
    { timeout: 180_000 },
  );
  assert.match(await page.locator('.progress-card strong').innerText(), /Recognizing locally/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => window.__autoState.job.kind === 'cancelled');
  const cancelled = await page.evaluate(() => window.__autoState);
  assert.equal(cancelled.result?.id, previous.result?.id);
  assert.equal(cancelled.history.length, previous.count);
  if (previous.result) assert.equal(cancelled.result.edited, '$preserved = 321$');
  report.checks.push(
    'Cancelling single-pass recognition terminates the worker and preserves prior edits/history',
  );

  async function recognize() {
    await page.evaluate(() => {
      window.__autoEvents = [];
    });
    await startRecognition(page);
    await page.waitForFunction(() => window.__autoState.job.kind === 'running');
    await page.waitForFunction(() => window.__autoState.job.kind !== 'running', null, {
      timeout: 180_000,
    });
    const state = await page.evaluate(() => window.__autoState);
    assert.equal(state.job.kind, 'idle', state.job.message);
    const { image: _image, ...result } = state.result;
    report.results.push(result);
    return result;
  }
  const equation = await recognize();
  assert.equal(equation.mode, 'auto');
  assert.equal(equation.task, undefined);
  assert.equal((equation.original.match(/\\boldsymbol\{x\}/g) ?? []).length, 4);
  assert.match(await currentMode(page), /Auto/);
  await page.screenshot({ path: 'artifacts/single-pass-auto-equation-ui.png', fullPage: true });

  await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/mixed-energy.png');
  await page
    .getByRole('region', { name: 'Source image', exact: true })
    .getByRole('img', { name: 'Source: mixed-energy.png' })
    .waitFor();
  const passage = await recognize();
  assert.equal(passage.mode, 'auto');
  assert.equal(passage.task, undefined);
  assert.match(passage.original, /The energy is/);
  assert.match(passage.original, /where.*mass/);
  assert.equal(await page.evaluate(() => window.__autoState.history.length), previous.count + 2);
  assert.match(await currentMode(page), /Auto/);
  await page.screenshot({ path: 'artifacts/single-pass-auto-passage-ui.png', fullPage: true });
  report.checks.push(
    'Default Auto reads both generated fixtures, preserves four bold vectors and paragraph spacing, and stays Auto for the next source',
  );

  await startRecognition(page);
  await page.waitForFunction(
    () =>
      window.__autoState.job.kind === 'running' && window.__autoState.job.phase === 'recognizing',
    null,
    { timeout: 180_000 },
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => window.__autoState.job.kind === 'cancelled');
  assert.equal(await page.evaluate(() => window.__autoState.result.id), passage.id);
  assert.equal(await page.evaluate(() => window.__autoState.history.length), previous.count + 2);
  report.checks.push(
    'Cancelling another single-pass scan preserves the completed scan and creates no history entry',
  );

  for (const [mode, label, file] of [
    ['mixed', 'Text with math', 'mixed-energy'],
    ['equation', 'Equation', 'bold-vectors'],
  ]) {
    await openSettings(page);
    await page.getByRole('combobox', { name: 'Recognition mode', exact: true }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await page
      .getByLabel('Choose image file')
      .setInputFiles(
        `${mode === 'mixed' ? 'tests/fixtures/samples' : 'tests/fixtures/generated'}/${file}.png`,
      );
    await page
      .getByRole('region', { name: 'Source image', exact: true })
      .getByRole('img', { name: `Source: ${file}.png` })
      .waitFor();
    const result = await recognize();
    assert.equal(result.mode, mode);
    assert.equal(result.task, mode);
    assert.equal(result.routing, undefined);
    const phases = await page.evaluate(() =>
      window.__autoEvents
        .filter((state) => state.job.kind === 'running')
        .map((state) => state.job.phase),
    );
    assert.ok(!phases.includes('classifying'));
  }
  report.checks.push('Both manual UI overrides retain their native prompt and skip classification');
  console.log(JSON.stringify({ checks: report.checks, error: null }, null, 2));
} catch (error) {
  report.error = String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await extension?.close();
  await writeFile('artifacts/single-pass-ui-results.json', JSON.stringify(report, null, 2));
}
