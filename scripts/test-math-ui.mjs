import {
  openSettings,
  openSavedScan,
  editSource,

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
  extension = await openExtension({
    profile: resolve(process.env.TEXIMAGESCAN_TEST_PROFILE ?? '.cache/production-profile'),
  });
  const { page } = extension;
  await page.evaluate(() => {
    window.__mathEvents = [];
    window.__mathPort = chrome.runtime.connect({ name: 'teximagescan-panel' });
    window.__mathPort.onMessage.addListener((state) => {
      window.__mathState = state;
      window.__mathEvents.push(state);
    });
  });
  await page.waitForFunction(() => window.__mathState);
  const previous = await page.evaluate(() => ({
    result: window.__mathState.result,
    count: window.__mathState.history.length,
  }));
  if (previous.result) {
    await openSavedScan(page, previous.result.name, previous.result.id);
    await editSource(page);
    await page.getByLabel('Editable source').fill('$preserved = 321$');
    await page.waitForFunction(() => window.__mathState.result.edited === '$preserved = 321$');
  }
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
      window.__mathState.job.kind === 'running' && window.__mathState.job.phase === 'recognizing',
    null,
    { timeout: 180_000 },
  );
  assert.match(await page.locator('.progress-card strong').innerText(), /Recognizing locally/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => window.__mathState.job.kind === 'cancelled');
  const cancelled = await page.evaluate(() => window.__mathState);
  assert.equal(cancelled.result?.id, previous.result?.id);
  assert.equal(cancelled.history.length, previous.count);
  if (previous.result) assert.equal(cancelled.result.edited, '$preserved = 321$');
  report.checks.push(
    'Cancelling recognition terminates the worker and preserves prior edits/history',
  );

  async function recognize() {
    await page.evaluate(() => {
      window.__mathEvents = [];
    });
    await startRecognition(page);
    await page.waitForFunction(() => window.__mathState.job.kind === 'running');
    await page.waitForFunction(() => window.__mathState.job.kind !== 'running', null, {
      timeout: 180_000,
    });
    const state = await page.evaluate(() => window.__mathState);
    assert.equal(state.job.kind, 'idle', state.job.message);
    const { image: _image, ...result } = state.result;
    report.results.push(result);
    return result;
  }
  const equation = await recognize();
  assert.equal(equation.mode, 'equation');
  assert.equal(equation.task, 'equation');
  assert.equal((equation.original.match(/\\(?:boldsymbol|mathbf)\{x\}/g) ?? []).length, 4);
  await page.screenshot({ path: 'artifacts/math-equation-ui.png', fullPage: true });

  await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/integral.png');
  await page
    .getByRole('region', { name: 'Source image', exact: true })
    .getByRole('img', { name: 'Source: integral.png' })
    .waitFor();
  const integral = await recognize();
  assert.equal(integral.mode, 'equation');
  assert.equal(integral.task, 'equation');


  assert.equal(await page.evaluate(() => window.__mathState.history.length), previous.count + 2);
  await page.screenshot({ path: 'artifacts/math-integral-ui.png', fullPage: true });
  report.checks.push(
    'The single math workflow recognizes formula crops, preserves bold vectors and keeps history',
  );

  await startRecognition(page);
  await page.waitForFunction(
    () =>
      window.__mathState.job.kind === 'running' && window.__mathState.job.phase === 'recognizing',
    null,
    { timeout: 180_000 },
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => window.__mathState.job.kind === 'cancelled');
  assert.equal(await page.evaluate(() => window.__mathState.result.id), integral.id);
  assert.equal(await page.evaluate(() => window.__mathState.history.length), previous.count + 2);
  report.checks.push(
    'Cancelling another scan preserves the completed scan and creates no history entry',
  );

  await openSettings(page);
  assert.equal(await page.getByRole('combobox', { name: 'Recognition mode', exact: true }).count(), 0);
  report.checks.push('Recognition settings expose the output limit without a mode selector');
  console.log(JSON.stringify({ checks: report.checks, error: null }, null, 2));
} catch (error) {
  report.error = String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await extension?.close();
  await writeFile('artifacts/math-ui-results.json', JSON.stringify(report, null, 2));
}
