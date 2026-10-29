import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { openExtension } from '../../scripts/browser.mjs';
import { openSavedScan } from '../../scripts/lib/panel.mjs';

test('panel styles keep framed controls and safe dialog focus at narrow widths', { tag: '@style' }, async ({}, testInfo) => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const image = 'data:image/png;base64,' +
      (await readFile('tests/fixtures/samples/energy.png')).toString('base64');
    const longName = 'equation-' + 'long-filename-'.repeat(12) + '.png';
    await page.evaluate(async ({ image, longName }) => {
      const request = indexedDB.open('teximagescan-prototype');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
      const result = {
        id: 'style-1',
        name: 'energy.png',
        image,
        original: '$$E=mc^2$$',
        edited: '$$E=mc^2$$',
        createdAt: '2026-10-25T10:00:00Z',
        elapsedMs: 1000,
        firstTokenMs: 100,
        tokenCount: 10,
        truncated: true,
        gpu: 'fixture',
        modelRevision: 'fixture',
        mode: 'auto',
      };
      const tx = db.transaction(['state', 'scans', 'images'], 'readwrite');
      for (const scan of [result, { ...result, id: 'style-2', name: longName, truncated: false }]) {
        const { image, ...metadata } = scan;
        tx.objectStore('scans').put(metadata, scan.id);
        tx.objectStore('images').put(image, scan.id);
      }
      tx.objectStore('state').put({
        model: 'missing',
        gpu: null,
        job: { kind: 'idle' },
        capture: { kind: 'idle' },
        result,
        input: { id: result.id, name: result.name, image },
      }, 'current');
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
      db.close();
      await chrome.offscreen.closeDocument();
    }, { image, longName });
    await page.reload();
    await openSavedScan(page, 'energy.png');
    const warning = page.locator('.result-view .rt-CalloutRoot');
    await expect(warning).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(warning).toHaveCSS('border-top-color', 'rgb(10, 10, 10)');
    await page.screenshot({ path: testInfo.outputPath('result-warning.png') });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByText('Model & diagnostics', { exact: true }).click();
    await page.getByLabel('Output token limit', { exact: true }).click();
    const menu = page.getByRole('listbox');
    await expect(menu).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(menu).toHaveCSS('box-shadow', 'none');
    await expect(menu).toHaveCSS('border-radius', '0px');
    await expect(menu).toHaveCSS('font-family', /Geist/);
    await page.screenshot({ path: testInfo.outputPath('settings-menu.png') });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Scan history', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('history-narrow.png') });
    const remove = page.getByRole('button', { name: 'Delete ' + longName, exact: true });
    await remove.click();
    const dialog = page.getByRole('alertdialog', { name: 'Delete scan?' });
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await expect(dialog).toHaveCSS('box-shadow', 'none');
    await expect(dialog).toHaveCSS('font-family', /Geist/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('delete-dialog-narrow.png') });
    await page.keyboard.press('Escape');
    await expect(remove).toBeFocused();
    await page.getByLabel('Choose image file').setInputFiles({
      name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid'),
    });
    await expect(page.getByRole('alert')).toContainText('Choose a PNG');
    await page.screenshot({ path: testInfo.outputPath('error-narrow.png') });
  } finally {
    await extension.close();
  }
});
