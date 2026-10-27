import {
  openSettings,
  openHistory,
  openSavedScan,
  backToScan,
  editSource,
} from '../../scripts/lib/panel.mjs';
import { mkdir } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { openExtension } from '../../scripts/browser.mjs';

test.beforeAll(() => mkdir('test-results', { recursive: true }));

test('installed extension opens, loads a crop, rejects invalid input, and stays usable at panel width', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await expect(page.locator('.model-card')).toContainText('TeleOCR');
    await expect(page.getByRole('button', { name: /Download model/ })).toBeEnabled();
    await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/energy.png');
    await backToScan(page);
    await expect(
      page
        .getByRole('region', { name: 'Source image', exact: true })
        .getByRole('img', { name: 'Source: energy.png' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recognize image' })).toBeDisabled();
    await page.getByLabel('Choose image file').setInputFiles({
      name: 'unsafe.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg/>'),
    });
    await expect(page.getByRole('alert')).toContainText('Choose a PNG');
    await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/energy.png');
    // exercise a missing-cache failure through the public panel protocol
    await backToScan(page);
    const image = await page
      .getByRole('region', { name: 'Source image', exact: true })
      .getByRole('img', { name: 'Source: energy.png' })
      .getAttribute('src');
    await page.evaluate(
      (image) =>
        new Promise((resolve) => {
          const port = chrome.runtime.connect({ name: 'teximagescan-panel' });
          port.onMessage.addListener(() => {
            port.disconnect();
            chrome.runtime
              .connect({ name: 'teximagescan-panel' })
              .postMessage({ type: 'recognize', name: 'test.png', image, maxTokens: 1024 });
            resolve();
          });
        }),
      image,
    );
    await expect(page.getByRole('alert')).toContainText(/Download the model first|WebGPU|adapter/i);
    await backToScan(page);
    await expect(
      page
        .getByRole('region', { name: 'Source image', exact: true })
        .getByRole('img', { name: 'Source: energy.png' }),
    ).toBeVisible();
    await page.setViewportSize({ width: 340, height: 1050 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/panel-empty.png', fullPage: true });
  } finally {
    await extension.close();
  }
});

test('an extension page can close and reconnect to the same offscreen host', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    await expect(extension.page.getByRole('button', { name: /Download model/ })).toBeEnabled();
    await extension.page.close();
    const reopened = await extension.context.newPage();
    await reopened.goto(`chrome-extension://${extension.id}/sidepanel.html`);
    await expect(reopened.getByRole('button', { name: /Download model/ })).toBeEnabled();
    expect(
      await reopened.evaluate(
        async () =>
          (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length,
      ),
    ).toBe(1);
  } finally {
    await extension.close();
  }
});

test('two panels synchronize retained edits without overwriting newer typing', async () => {
  const extension = await openExtension();
  try {
    const { page } = extension;
    await expect(page.getByRole('button', { name: /Download model/ })).toBeEnabled();
    await page.evaluate(async () => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (contexts.length !== 1) throw new Error('Expected one host');
      const request = indexedDB.open('teximagescan-prototype');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
      const transaction = db.transaction('state', 'readwrite');
      transaction.objectStore('state').put(
        {
          model: 'missing',
          gpu: null,
          job: { kind: 'idle' },
          result: {
            id: 'retained-fixture',
            name: 'test.png',
            image: 'data:image/png;base64,AAAA',
            original: '$x=1$',
            edited: '$x=1$',
            createdAt: new Date().toISOString(),
            elapsedMs: 1,
            firstTokenMs: 1,
            tokenCount: 1,
            truncated: false,
            gpu: 'fixture',
            modelRevision: 'fixture',
          },
        },
        'current',
      );
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = reject;
      });
      db.close();
      await chrome.offscreen.closeDocument();
    });
    const first = await extension.context.newPage();
    await first.goto(`chrome-extension://${extension.id}/sidepanel.html`);
    await openSavedScan(first, 'test.png');
    await editSource(first);
    await expect(first.getByLabel('Editable source')).toHaveValue('$x=1$');
    const second = await extension.context.newPage();
    await second.goto(first.url());
    await openSavedScan(second, 'test.png');
    await editSource(second);
    await expect(second.getByLabel('Editable source')).toHaveValue('$x=1$');
    await editSource(first);
    await first.getByLabel('Editable source').fill('$x=123456789$');
    await editSource(second);
    await expect(second.getByLabel('Editable source')).toHaveValue('$x=123456789$');
    await editSource(second);
    await second.getByLabel('Editable source').fill('$y=2$');
    await editSource(first);
    await expect(first.getByLabel('Editable source')).toHaveValue('$y=2$');
    await editSource(first);
    await first.getByLabel('Editable source').pressSequentially(' + rapid typing', { delay: 5 });
    await editSource(first);
    await expect(first.getByLabel('Editable source')).toHaveValue('$y=2$ + rapid typing');
    await editSource(second);
    await expect(second.getByLabel('Editable source')).toHaveValue('$y=2$ + rapid typing');
    await first.getByText('Scan details', { exact: true }).click();
    await expect(
      first.locator('.scan-metadata').getByText('previous model', { exact: true }),
    ).toBeVisible();
    await first.evaluate(async () => {
      await (
        await caches.open('teximagescan-model-old')
      ).put('https://example.com/old', new Response('old model'));
    });
    await openSettings(first);
    await first.getByText('Model & diagnostics', { exact: true }).click();
    await first.getByRole('button', { name: 'Remove model', exact: true }).click();
    await first.waitForFunction(
      async () => !(await caches.keys()).some((name) => name.startsWith('teximagescan-model-')),
    );
    await editSource(first);
    await expect(first.getByLabel('Editable source')).toHaveValue('$y=2$ + rapid typing');
  } finally {
    await extension.close();
  }
});

test('Auto is the default for uploads while manual overrides remain available', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await openSettings(page);
    await expect(
      page.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Auto');
    await expect(page.getByLabel('Sample image')).toHaveCount(0);
    await expect(page.getByText('Try a sample', { exact: true })).toHaveCount(0);
    await page
      .getByLabel('Choose image file')
      .setInputFiles('tests/fixtures/generated/bold-vectors.png');
    await backToScan(page);
    await expect(
      page
        .getByRole('region', { name: 'Source image', exact: true })
        .getByRole('img', { name: 'Source: bold-vectors.png' }),
    ).toBeVisible();
    await openSettings(page);
    await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/mixed-multiline.png');
    await backToScan(page);
    await expect(
      page
        .getByRole('region', { name: 'Source image', exact: true })
        .getByRole('img', { name: 'Source: mixed-multiline.png' }),
    ).toBeVisible();
    await openSettings(page);
    await expect(
      page.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Auto');
    await openSettings(page);
    await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/mixed-energy.png');
    await backToScan(page);
    await expect(
      page
        .getByRole('region', { name: 'Source image', exact: true })
        .getByRole('img', { name: 'Source: mixed-energy.png' }),
    ).toBeVisible();
    await openSettings(page);
    await expect(
      page.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Auto');
    await openSettings(page);
    await page.getByRole('combobox', { name: 'Recognition mode', exact: true }).click();
    await page.getByRole('option', { name: 'Equation', exact: true }).click();
    await openSettings(page);
    await expect(
      page.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Equation');
    await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/energy.png');
    await backToScan(page);
    await expect(
      page
        .getByRole('region', { name: 'Source image', exact: true })
        .getByRole('img', { name: 'Source: energy.png' }),
    ).toBeVisible();
    await openSettings(page);
    await expect(
      page.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Equation');
    await openSettings(page);
    await page.getByRole('combobox', { name: 'Recognition mode', exact: true }).click();
    await page.getByRole('option', { name: 'Text with math', exact: true }).click();
    await openSettings(page);
    await expect(
      page.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Text with math');
    await openSettings(page);
    await page.getByRole('combobox', { name: 'Recognition mode', exact: true }).click();
    await page.getByRole('option', { name: 'Auto', exact: true }).click();
    await openSettings(page);
    await expect(
      page.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Auto');
  } finally {
    await extension.close();
  }
});
