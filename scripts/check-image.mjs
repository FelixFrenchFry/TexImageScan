import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { openExtension } from '../scripts/browser.mjs';
import assert from 'node:assert/strict';

const input = process.argv[2];
if (!input) throw new Error('Provide the crop image path');
const image = `data:image/png;base64,${(await readFile(input)).toString('base64')}`;
const report = { input, cases: [] };
const benchmark = process.argv.includes('--benchmark');
const extension = await openExtension(
  benchmark
    ? {
        directory: '.output/chrome-mv3-benchmark',
        profile: resolve('.cache/benchmark-profile'),
        gpu: false,
      }
    : { profile: resolve('.cache/production-profile'), gpu: false },
);
try {
  const { page } = extension;
  await page.evaluate(() => {
    window.__port = chrome.runtime.connect({ name: 'teximagescan-panel' });
    window.__port.onMessage.addListener((state) => {
      window.__state = state;
    });
  });
  await page.waitForFunction(() => window.__state);
  for (const scale of [1, 2, 3]) {
    const source =
      scale === 1
        ? image
        : await page.evaluate(
            async ({ image, scale }) => {
              const bitmap = await createImageBitmap(await (await fetch(image)).blob());
              const canvas = document.createElement('canvas');
              canvas.width = bitmap.width * scale;
              canvas.height = bitmap.height * scale;
              const context = canvas.getContext('2d');
              context.imageSmoothingQuality = 'high';
              context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
              bitmap.close();
              return canvas.toDataURL('image/png');
            },
            { image, scale },
          );
    await page.evaluate(
      ({ image, name }) =>
        window.__port.postMessage({
          type: 'recognize',
          name,
          image,
          maxTokens: 1024,
          task: 'equation',
        }),
      { image: source, name: basename(input) },
    );
    await page.waitForFunction(() => window.__state.job.kind === 'running');
    await page.waitForFunction(() => window.__state.job.kind !== 'running', null, {
      timeout: 180_000,
    });
    const state = await page.evaluate(() => window.__state);
    if (state.job.kind !== 'idle') throw new Error(state.job.message);
    const result = {
      scale,
      original: state.result.original,
      elapsedMs: state.result.elapsedMs,
      modelRevision: state.result.modelRevision,
    };
    report.cases.push(result);
    console.log(JSON.stringify(result));
    if (process.argv.includes('--expect-bold-vectors')) {
      assert.equal(
        (result.original.match(/\\boldsymbol\{x\}/g) ?? []).length,
        4,
        'All four x vectors must remain bold',
      );
    }
  }
} finally {
  await extension.close();
  await writeFile('artifacts/image-check.json', JSON.stringify(report, null, 2));
}
