import { openSavedScan, backToScan, editSource, startRecognition } from './lib/panel.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openExtension } from './browser.mjs';

await mkdir('artifacts', { recursive: true });
const lasso = process.argv.includes('--lasso');
const prefix = lasso ? 'lasso' : 'capture';
const png = await readFile('tests/fixtures/generated/bold-vectors.png');
const server = createServer((request, response) => {
  if (request.url === '/equation.png') {
    response.writeHead(200, { 'Content-Type': 'image/png' });
    response.end(png);
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(
    '<!doctype html><title>Scientific equation</title><style>body{margin:0;background:#f7f7f4}h1{font:20px system-ui;margin:24px 60px}img{position:absolute;left:60px;top:120px}</style><h1>Local capture verification</h1><img src="/equation.png" alt="Gradient equation">',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const report = {
  date: new Date().toISOString(),
  shape: lasso ? 'lasso' : 'rectangle',
  browser: '',
  unsafeWebgpuFlag: false,
  checks: [],
  result: null,
  error: null,
};
let extension;
try {
  extension = await openExtension({
    profile: resolve('.cache/production-profile'),
    gpu: false,
    extensionDebug: true,
  });
  const { page, context } = extension;
  report.browser = context.browser().version();
  await page.evaluate(() => {
    window.__port = chrome.runtime.connect({ name: 'teximagescan-panel' });
    window.__port.onMessage.addListener((state) => {
      window.__state = state;
    });
  });
  await page.waitForFunction(() => window.__state);
  page.on('dialog', (dialog) => dialog.accept());
  const previous = await page.evaluate(() => window.__state.result);
  if (previous) {
    await openSavedScan(page, previous.name, previous.id);
    await editSource(page);
    await page.getByLabel('Editable source').fill('$preserved = 123$');
    await page.waitForFunction(() => window.__state.result.edited === '$preserved = 123$');
  }
  const target = await context.newPage();
  await target.setViewportSize({ width: 1000, height: 720 });
  await target.goto(url);
  await target.getByRole('img', { name: 'Gradient equation' }).waitFor();
  await target.bringToFront();
  const cdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets', {
    filter: [{ type: 'tab' }, { exclude: true }],
  });
  const tab = targetInfos.find((info) => info.url === url);
  assert.ok(tab);
  await cdp.send('Extensions.triggerAction', { id: extension.id, targetId: tab.targetId });
  // use a DOM click to avoid activating this standalone panel tab
  // native side panels leave the webpage active
  await backToScan(page);
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Capture')
      .click(),
  );
  await target.locator('[data-teximagescan-capture]').waitFor();
  const rect = await target.getByRole('img', { name: 'Gradient equation' }).boundingBox();
  assert.ok(rect);
  if (lasso) {
    await target.keyboard.press('Tab');
    await target.keyboard.press('Tab');
    await target.keyboard.press('Enter');
    // leave the bounding corner outside the lasso while retaining every equation symbol

    const x = rect.x - 8,
      y = rect.y - 8,
      w = rect.width + 16,
      h = rect.height + 16;
    const points = [
      [x + 16, y],
      [x + w - 16, y],
      [x + w, y + 12],
      [x + w, y + h - 12],
      [x + w - 16, y + h],
      [x + 16, y + h],
      [x, y + h - 12],
      [x, y + 12],
    ];
    await target.mouse.move(...points[0]);
    await target.mouse.down();
    for (const point of points.slice(1)) await target.mouse.move(...point, { steps: 5 });
  } else {
    await target.mouse.move(rect.x - 4, rect.y - 4);
    await target.mouse.down();
    await target.mouse.move(rect.x + rect.width + 4, rect.y + rect.height + 4, { steps: 12 });
  }
  await target.screenshot({ path: `artifacts/${prefix}-selection.png` });
  await target.mouse.up();
  await page.waitForFunction(
    () =>
      window.__state.capture.kind === 'idle' && window.__state.input?.name.startsWith('Page crop'),
  );
  const staged = await page.evaluate(() => window.__state);
  assert.equal(staged.job.kind, 'idle');
  if (previous) {
    assert.equal(staged.result.id, previous.id);
    assert.equal(staged.result.edited, '$preserved = 123$');
    report.checks.push('Capture preserved the previously edited OCR result');
  }
  await writeFile(
    `artifacts/${lasso ? 'lassoed' : 'captured'}-equation.png`,
    Buffer.from(staged.input.image.split(',')[1], 'base64'),
  );
  if (lasso) {
    const corner = await page.evaluate(async () => {
      const bitmap = await createImageBitmap(
        await (await fetch(window.__state.input.image)).blob(),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return [...ctx.getImageData(1, 1, 1, 1).data];
    });
    assert.deepEqual(corner, [255, 255, 255, 255]);
    report.checks.push('Freehand outline closed on release and excluded pixels are opaque white');
  }
  report.checks.push('Real toolbar activeTab grant, page selection, and crop preview succeeded');
  await startRecognition(page);
  await page.waitForFunction(() => window.__state.job.kind === 'running');
  await page.waitForFunction(() => window.__state.job.kind !== 'running', null, {
    timeout: 180_000,
  });
  const state = await page.evaluate(() => window.__state);
  assert.equal(state.job.kind, 'idle', state.job.message);
  assert.equal((state.result.original.match(/\\boldsymbol\{x\}/g) ?? []).length, 4);
  assert.equal(state.result.truncated, false);
  await page.getByRole('button', { name: 'Copy Markdown with math', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Copied Markdown' }).waitFor();
  report.result = {
    original: state.result.original,
    elapsedMs: state.result.elapsedMs,
    modelRevision: state.result.modelRevision,
    gpu: state.result.gpu,
  };
  report.checks.push(
    'Captured equation recognized locally with all four bold vectors, previewed, and copied',
  );
  await page.screenshot({ path: `artifacts/${prefix}-result.png`, fullPage: true });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
  process.exitCode = 1;
  if (extension)
    console.error(
      await extension.page.evaluate(() => ({
        alerts: [...document.querySelectorAll('[role=alert]')].map((el) => el.textContent),
        capture: window.__state?.capture,
        job: window.__state?.job,
      })),
    );
} finally {
  await extension?.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(`artifacts/${prefix}-production.json`, JSON.stringify(report, null, 2));
}
