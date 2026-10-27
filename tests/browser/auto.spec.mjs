import {
  openSettings,
  openHistory,
  openSavedScan,
  backToScan,
  editSource,
} from '../../scripts/lib/panel.mjs';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openExtension } from '../../scripts/browser.mjs';

test('old Auto scans retain source and mode without obsolete classifier notices', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    const image = `data:image/png;base64,${(await readFile('tests/fixtures/samples/energy.png')).toString('base64')}`;
    await page.evaluate(async (image) => {
      const request = indexedDB.open('teximagescan-prototype');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(
        {
          model: 'missing',
          gpu: null,
          job: { kind: 'idle' },
          result: {
            id: 'fallback',
            name: 'uncertain.png',
            image,
            original: '$E=mc^2$',
            edited: '$E=mc^2$',
            createdAt: new Date().toISOString(),
            elapsedMs: 1,
            firstTokenMs: 1,
            tokenCount: 1,
            truncated: false,
            gpu: 'test',
            modelRevision: 'test',
            mode: 'auto',
            task: 'mixed',
            routing: { reason: 'invalid', raw: '<box:incomplete', elapsedMs: 1, tokenCount: 1 },
          },
        },
        'current',
      );
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
      db.close();
      await chrome.offscreen.closeDocument();
    }, image);
    await page.reload();
    await openSavedScan(page, 'uncertain.png');
    await openSettings(page);
    await expect(
      page.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Auto');
    await openSettings(page);
    await expect(page.getByText('Auto', { exact: true }).last()).toBeVisible();
    await expect(page.getByText(/Auto could not identify the content reliably/)).toHaveCount(0);
    await openSettings(page);
    await page.getByRole('button', { name: 'About recognition mode', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('reads text and equations in one pass.');
    await page.keyboard.press('Escape');
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue('$E=mc^2$');
    await expect(page.locator('body')).not.toContainText('<box:');
  } finally {
    await extension.close();
  }
});
