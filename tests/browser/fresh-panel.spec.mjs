import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { openExtension, waitForPanel } from '../../scripts/browser.mjs';
import { openSavedScan } from '../../scripts/lib/panel.mjs';

async function savedScan(extension, job = { kind: 'idle' }) {
  const image = `data:image/png;base64,${(await readFile('tests/fixtures/samples/energy.png')).toString('base64')}`;
  await extension.page.evaluate(async ({ image, job }) => {
    const request = indexedDB.open('teximagescan-prototype');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = reject;
    });
    const result = {
      id: 'saved-fresh',
      name: 'energy.png',
      image,
      original: '$E=mc^2$',
      edited: '$E=mc^3$',
      createdAt: '2026-10-26T12:18:00Z',
      elapsedMs: 1200,
      firstTokenMs: 100,
      tokenCount: 12,
      truncated: false,
      gpu: 'fixture',
      modelRevision: 'fixture',
      mode: 'equation',
    };
    const { image: crop, ...metadata } = result;
    const tx = db.transaction(['state', 'scans', 'images'], 'readwrite');
    tx.objectStore('scans').put(metadata, result.id);
    tx.objectStore('images').put(crop, result.id);
    tx.objectStore('state').put(
      {
        model: 'missing',
        gpu: null,
        job,
        capture: { kind: 'idle' },
        result,
        input: { id: 'crop', name: result.name, image },
      },
      'current',
    );
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
    db.close();
    await chrome.offscreen.closeDocument();
  }, { image, job });
  await extension.page.reload();
  await waitForPanel(extension.page);
}

for (const job of [
  { kind: 'failed', message: 'Previous recognition failed.' },
  { kind: 'cancelled' },
  { kind: 'interrupted' },
]) {
  test(`uploading a new source clears the previous ${job.kind} recognition notice`, async () => {
    const extension = await openExtension({ gpu: false });
    try {
      const { page } = extension;
      await savedScan(extension, job);
      const notice = job.kind === 'failed'
        ? page.getByRole('alert').filter({ hasText: job.message })
        : page.getByText(job.kind === 'cancelled'
          ? 'Cancelled. Your previous result is preserved.'
          : /The previous operation was interrupted/);
      await expect(notice).toBeVisible();
      await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/integral.png');
      await expect(page.getByRole('img', { name: 'Source: integral.png', exact: true })).toBeVisible();
      await expect(notice).toHaveCount(0);
      await page.getByRole('button', { name: 'Scan history', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Open energy.png', exact: true })).toBeVisible();
    } finally {
      await extension.close();
    }
  });
}

test('reloaded and reopened panels start fresh while the saved scan remains in History', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    let page = extension.page;
    await savedScan(extension);
    await expect(page.getByRole('heading', { name: 'What would you like to scan?' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Recognition result' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Scan history', exact: true }).click();
    await expect(page.locator('.history-list li.active')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open energy.png', exact: true }).locator('.katex annotation')).toHaveText('E=mc^3');
    await page.getByRole('button', { name: 'Open energy.png', exact: true }).click();
    await expect(page.getByRole('img', { name: 'Source: energy.png', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await expect(page.getByLabel('Editable source')).toHaveValue('$E=mc^3$');
    await page.getByLabel('Editable source').fill('$E=mc^4$');
    await page.getByRole('button', { name: 'Scan history', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open energy.png', exact: true }).locator('.katex annotation')).toHaveText('E=mc^4');
    const url = page.url();
    await page.close();
    page = await extension.context.newPage();
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'What would you like to scan?' })).toBeVisible();
    await page.getByRole('button', { name: 'Scan history', exact: true }).click();
    await expect(page.locator('.history-list li.active')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open energy.png', exact: true }).locator('.katex annotation')).toHaveText('E=mc^4');
  } finally {
    await extension.close();
  }
});

test('a new upload in a fresh panel does not reactivate an old result', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await savedScan(extension);
    await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/integral.png');
    await expect(page.getByRole('heading', { name: 'Ready to recognize' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Previous result' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Recognition result' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Scan history', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open energy.png', exact: true })).toBeVisible();
    await openSavedScan(page, 'energy.png');
    await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/energy.png');
    await expect(page.getByRole('heading', { name: 'Ready to recognize' })).toBeVisible();
    const reopened = await extension.context.newPage();
    await reopened.goto(page.url());
    await expect(reopened.getByRole('heading', { name: 'What would you like to scan?' })).toBeVisible();
    await expect(reopened.getByRole('region', { name: 'Source image' })).toHaveCount(0);
    await expect(reopened.getByRole('region', { name: 'Recognition result' })).toHaveCount(0);
  } finally {
    await extension.close();
  }
});

test('opening during recognition follows the active input and displays the completed result', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await savedScan(extension);
    // send progress through the panel state boundary without running inference
    await page.addInitScript(() => {
      const connect = chrome.runtime.connect.bind(chrome.runtime);
      chrome.runtime.connect = (...args) => {
        const port = connect(...args);
        const addListener = port.onMessage.addListener.bind(port.onMessage);
        port.onMessage.addListener = (listener) =>
          addListener((state) => {
            window.finishRecognition = () =>
              listener({
                ...state,
                job: { kind: 'idle' },
                result: { ...state.result, id: 'completed-in-panel' },
                input: { ...state.input, id: 'completed-in-panel' },
              });
            listener({
              ...state,
              job: {
                kind: 'running',
                id: 'active-job',
                phase: 'recognizing',
                detail: 'Reading image',
                fraction: null,
                text: '',
              },
            });
          });
        return port;
      };
    });
    await page.reload();
    await expect(page.locator('.progress-card')).toContainText('Recognizing locally');
    await expect(page.getByRole('img', { name: 'Source: energy.png', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Previous result' })).toHaveCount(0);
    await page.evaluate(() => window.finishRecognition());
    await expect(page.getByRole('region', { name: 'Recognition result' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy LaTeX', exact: true })).toBeEnabled();
  } finally {
    await extension.close();
  }
});

test('reconnecting the same panel keeps an explicitly opened history scan active', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await savedScan(extension);
    await openSavedScan(page, 'energy.png');
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const port = chrome.runtime.connect({ name: 'teximagescan-panel' });
          port.onDisconnect.addListener(resolve);
          void chrome.offscreen.closeDocument();
        }),
    );
    await expect(
      page.getByText('Reconnecting to local model host…', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled();
    await expect(page.getByRole('region', { name: 'Recognition result' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await expect(page.getByLabel('Editable source')).toHaveValue('$E=mc^3$');
  } finally {
    await extension.close();
  }
});
