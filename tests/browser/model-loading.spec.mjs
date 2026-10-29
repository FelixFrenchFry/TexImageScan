import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { openExtension } from '../../scripts/browser.mjs';

const manifest = JSON.parse(await readFile('src/model-manifest.json', 'utf8'));

async function cachedPanel(extension, job = { kind: 'idle' }) {
  await extension.page.evaluate(
    async ({ manifest, job }) => {
      const base =
        'https://huggingface.co/' + manifest.repository + '/resolve/' + manifest.revision + '/';
      const cache = await caches.open('teximagescan-model-' + manifest.revision);
      // cache readiness uses metadata without running inference on fake weights
      for (const file of manifest.files)
        await cache.put(
          base + file.path,
          new Response('', { headers: { 'content-length': String(file.size) } }),
        );
      await cache.put(base + '__verified__', new Response(manifest.revision));
      const request = indexedDB.open('teximagescan-prototype');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(
        {
          model: 'cached',
          gpu: null,
          job,
          result: null,
          input: null,
          capture: { kind: 'idle' },
          history: [],
        },
        'current',
      );
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
      db.close();
      await chrome.offscreen.closeDocument();
    },
    { manifest, job },
  );
  await extension.page.reload();
  await expect(
    extension.page.getByRole('button', { name: 'Capture', exact: true }),
  ).toBeEnabled();
}

test('downloaded models need no manual loading in scan or Settings', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await cachedPanel(extension);
    await expect(page.getByRole('region', { name: 'Model setup' })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Model status: Ready', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Model setup' })).toContainText('automatically');
    await expect(
      page.getByRole('button', { name: /Load cached model|Download.*model/ }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to scan', exact: true }).click();
    await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/energy.png');
    await expect(page.getByRole('button', { name: 'Recognize image', exact: true })).toBeEnabled();
    await page.evaluate(() => {
      window.__modelEvents = [];
      window.__modelPort = chrome.runtime.connect({ name: 'teximagescan-panel' });
      window.__modelPort.onMessage.addListener((state) => window.__modelEvents.push(state));
    });
    // simulate cache eviction after startup
    // restore the download action instead of leaving a retry loop
    await page.evaluate(async (manifest) => {
      const cache = await caches.open('teximagescan-model-' + manifest.revision);
      await cache.delete(
        'https://huggingface.co/' +
          manifest.repository +
          '/resolve/' +
          manifest.revision +
          '/' + manifest.files[0].path,
      );
    }, manifest);
    await page.getByRole('button', { name: 'Recognize image', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__modelEvents.some(
            (state) => state.job.kind === 'running' && state.job.phase === 'loading',
          ),
        ),
      )
      .toBe(true);
    // retain the image and offer cache repair after the worker error
    await expect(page.getByRole('alert')).toContainText(/Download the model first|WebGPU|adapter/i);
    await expect(page.getByRole('img', { name: 'Source: energy.png' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Download model/ })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Recognize image', exact: true })).toBeDisabled();
  } finally {
    await extension.close();
  }
});

test('missing model explains the download size and requires an explicit download', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await expect(page.getByRole('region', { name: 'Model setup' })).toContainText('once');
    const size = (manifest.totalBytes / 1e9).toFixed(2).replace('.', '\\.');
    await expect(page.getByRole('button', { name: new RegExp(`Download model.*${size} GB`) })).toBeEnabled();
    await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/energy.png');
    await expect(page.getByRole('button', { name: 'Recognize image', exact: true })).toBeDisabled();
  } finally {
    await extension.close();
  }
});

test('interrupted cached recognition asks for a retry without manual preparation', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await cachedPanel(extension, { kind: 'interrupted' });
    await expect(page.getByText(/The previous operation was interrupted/)).toContainText(
      'Retry recognition',
    );
    await expect(page.getByRole('region', { name: 'Model setup' })).toHaveCount(0);
  } finally {
    await extension.close();
  }
});

test('loading and recognition progress stay below the action without moving the source or controls', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    // send progress through the state listener without inference
    await page.addInitScript(() => {
      const connect = chrome.runtime.connect.bind(chrome.runtime);
      chrome.runtime.connect = (...args) => {
        const port = connect(...args);
        const addListener = port.onMessage.addListener.bind(port.onMessage);
        port.onMessage.addListener = (listener) =>
          addListener((state) => {
            window.showProgress = (job) => listener({ ...state, job });
            listener(state);
          });
        return port;
      };
    });
    await cachedPanel(extension);
    await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/energy.png');
    const original = page.getByRole('button', { name: 'Choose source image', exact: true });
    const action = page.getByRole('button', { name: 'Recognize image', exact: true });
    for (const width of [430, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      await expect(action).toBeEnabled();
      const before = { original: await original.boundingBox(), action: await action.boundingBox() };
      for (const phase of ['loading', 'recognizing']) {
        await page.evaluate(
          (phase) =>
            window.showProgress({
              kind: 'running',
              id: 'layout-fixture',
              phase,
              detail: phase === 'loading' ? 'Creating WebGPU sessions…' : 'Reading image…',
              fraction: null,
              text: '',
            }),
          phase,
        );
        const progress = page.locator('.progress-card');
        await expect(progress).toContainText(
          phase === 'loading' ? 'Loading model' : 'Recognizing locally',
        );
        // unknown progress must not produce a looping bar
        await expect(progress.getByRole('progressbar')).toHaveCount(0);
        expect(await original.boundingBox()).toEqual(before.original);
        expect(await action.boundingBox()).toEqual(before.action);
        expect((await progress.boundingBox()).y).toBeGreaterThanOrEqual(
          before.action.y + before.action.height,
        );
        await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
      }
      for (const fraction of [0, 0.25, 0.75, 1]) {
        await page.evaluate(
          (fraction) =>
            window.showProgress({
              kind: 'running',
              id: 'layout-fixture',
              phase: 'loading',
              detail: 'Loading model data…',
              fraction,
              text: '',
            }),
          fraction,
        );
        const progress = page.locator('.progress-card');
        await expect(progress.getByRole('progressbar', { name: 'Loading model' })).toHaveJSProperty(
          'value',
          fraction,
        );
        await expect(progress).toContainText(`${fraction * 100}%`);
      }
      await page.screenshot({
        path: `test-results/recognition-progress-${width}.png`,
        fullPage: true,
      });
      await page.evaluate(() => window.showProgress({ kind: 'idle' }));
      await expect(page.locator('.progress-card')).toHaveCount(0);
    }
  } finally {
    await extension.close();
  }
});
