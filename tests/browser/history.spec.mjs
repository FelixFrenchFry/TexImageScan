import {
  openSettings,
  openHistory,
  openSavedScan,
  backToScan,
  editSource,
  currentMode,
  setMode,
} from '../../scripts/lib/panel.mjs';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { openExtension, waitForPanel } from '../../scripts/browser.mjs';

async function seed(extension, count = 2, duplicateNames = false) {
  const image = `data:image/png;base64,${(await readFile('tests/fixtures/samples/energy.png')).toString('base64')}`;
  await extension.page.evaluate(
    async ({ image, count, duplicateNames }) => {
      const request = indexedDB.open('teximagescan-prototype');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
      const tx = db.transaction(['state', 'scans', 'images'], 'readwrite');
      const result = {
        id: 'first',
        name: 'first.png',
        image,
        original: '$x=1$',
        edited: '$x=2$',
        createdAt: '2026-10-24T10:00:00Z',
        elapsedMs: 1,
        firstTokenMs: 1,
        tokenCount: 1,
        truncated: false,
        gpu: 'fixture',
        modelRevision: 'fixture',
        task: 'equation',
        mode: duplicateNames ? 'equation' : 'auto',
      };
      const second = {
        ...result,
        mode: undefined,
        id: 'second',
        name: duplicateNames ? result.name : 'second.png',
        original: 'Energy $E=mc^2$.',
        edited: 'Energy $E=mc^2$.',
        createdAt: '2026-10-24T11:00:00Z',
        task: 'mixed',
      };
      const extra = Array.from({ length: count - 2 }, (_, index) => ({
        ...result,
        id: `extra-${index}`,
        name: duplicateNames ? result.name : `scan-${index + 3}.png`,
        original: `$z=${index + 3}$`,
        edited: `$z=${index + 3}$`,
        createdAt: `2026-10-24T12:${String(index).padStart(2, '0')}:00Z`,
      }));
      for (const scan of [result, second, ...extra]) {
        const { image, ...metadata } = scan;
        tx.objectStore('scans').put(metadata, scan.id);
        tx.objectStore('images').put(image, scan.id);
      }
      const current = duplicateNames ? result : second;
      tx.objectStore('state').put(
        {
          model: 'missing',
          gpu: null,
          job: { kind: 'idle' },
          capture: { kind: 'idle' },
          result: current,
          input: { id: current.id, image, name: current.name },
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
    { image, count, duplicateNames },
  );
  await extension.page.reload();
  await waitForPanel(extension.page);
  await expect(
    extension.page.getByRole('heading', { name: 'What would you like to scan?' }),
  ).toBeVisible();
}

test('smoke setup reopens the retained scan by ID among duplicate filenames and restores Auto', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await seed(extension, 25, true);
    expect(await currentMode(page)).toBe('Auto');
    await expect(openSavedScan(page, 'first.png', 'missing')).rejects.toThrow('no longer available');
    await openSavedScan(page, 'first.png', 'first');
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue('$x=2$');
    expect(await currentMode(page)).toBe('Equation');
    await editSource(page);
    await page.getByLabel('Editable source').fill('$preserved=321$');
    await setMode(page, 'Auto');
    await page
      .getByLabel('Choose image file')
      .setInputFiles('tests/fixtures/generated/bold-vectors.png');
    await expect(page.getByRole('heading', { name: 'Ready to recognize' })).toBeVisible();
    expect(await currentMode(page)).toBe('Auto');
  } finally {
    await extension.close();
  }
});

test('opens, edits, combines and persists scans while keeping original OCR and crop', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await extension.context.grantPermissions(['clipboard-read']);
    await seed(extension);
    await openSettings(page);
    await expect(
      page.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Auto');
    await openHistory(page);
    await page.getByRole('button', { name: 'Open first.png' }).click();
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue('$x=2$');
    await backToScan(page);
    await expect(page.getByRole('img', { name: 'Source: first.png' })).toBeVisible();
    await openSettings(page);
    await expect(
      page.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Auto');
    await editSource(page);
    await page.getByLabel('Editable source').fill('$x=99$');
    await openHistory(page);
    await expect(page.getByRole('region', { name: 'Scan history' })).toContainText('$x=99$');
    await openHistory(page);
    await page.getByLabel('Select first.png').check();
    await page.getByLabel('Select second.png').check();
    await openHistory(page);
    await page.getByRole('button', { name: 'Copy selected', exact: true }).click();
    await openHistory(page);
    await expect(page.getByRole('button', { name: 'Copied selection' })).toBeVisible();
    expect(
      await page.evaluate(async () =>
        (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'),
      ),
    ).toBe('$x=99$\n\nEnergy $E=mc^2$.');
    await openHistory(page);
    await page.getByLabel('History copy format').click();
    await page.getByRole('option', { name: 'LaTeX / mixed source', exact: true }).click();
    await page.getByRole('button', { name: /Copy selected|Copied selection/ }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n')),
      )
      .toBe('x=99\n\nEnergy $E=mc^2$.');
    const second = await extension.context.newPage();
    await second.goto(page.url());
    await openSavedScan(second, 'first.png');
    await editSource(second);
    await expect(second.getByLabel('Editable source')).toHaveValue('$x=99$');
    await openSettings(second);
    await expect(
      second.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Auto');
    await openSettings(second);
    await second.getByRole('combobox', { name: 'Recognition mode', exact: true }).click();
    await second.getByRole('option', { name: 'Equation', exact: true }).click();
    await editSource(second);
    await second.getByLabel('Editable source').fill('$x=100$');
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue('$x=100$');
    await openSettings(second);
    await expect(
      second.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Equation');
    await editSource(page);
    await page.reload();
    await openSavedScan(page, 'first.png');
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue('$x=100$');
    await openHistory(page);
    await page.getByRole('button', { name: 'Open second.png' }).click();
    await openSettings(page);
    await expect(
      page.getByRole('combobox', { name: 'Recognition mode', exact: true }),
    ).toContainText('Text with math');
    await openHistory(page);
    await page.getByRole('button', { name: 'Open first.png' }).click();
    await editSource(page);
    await page.getByRole('button', { name: 'Reset edits' }).click();
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue('$x=1$');
    await page.setViewportSize({ width: 340, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/history-narrow.png', fullPage: true });
  } finally {
    await extension.close();
  }
});

test('paginates larger histories and copies selected scans beyond the visible page', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await extension.context.grantPermissions(['clipboard-read']);
    await seed(extension, 25);
    await openHistory(page);
    const history = page.getByRole('region', { name: 'Scan history' });
    await openHistory(page);
    await expect(history.getByRole('checkbox')).toHaveCount(20);
    await openHistory(page);
    await history.getByRole('button', { name: 'Select all', exact: true }).click();
    await openHistory(page);
    await expect(history.getByRole('status')).toHaveText('25 selected');
    await openHistory(page);
    await history.getByRole('button', { name: 'Copy selected', exact: true }).click();
    await openHistory(page);
    await expect(
      history.getByRole('button', { name: 'Copied selection', exact: true }),
    ).toBeVisible();
    const text = await page.evaluate(async () =>
      (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'),
    );
    expect(text.split('\n\n')).toHaveLength(25);
    expect(text.startsWith('$x=2$\n\nEnergy $E=mc^2$.')).toBe(true);
    await openHistory(page);
    await history.getByRole('button', { name: 'Show more scans', exact: true }).click();
    await openHistory(page);
    await expect(history.getByRole('checkbox')).toHaveCount(25);
  } finally {
    await extension.close();
  }
});

for (const input of ['integral', 'energy']) {
  test(`deletion and clearing preserve the pending ${input}.png without resurrecting scans`, async () => {
    const extension = await openExtension({ gpu: false });
    try {
      const { page } = extension;
      await seed(extension);
      await openSettings(page);
      await page.getByText('Model & diagnostics', { exact: true }).click();
      await page.getByRole('button', { name: 'Clear result', exact: true }).click();
      await openHistory(page);
      await expect(page.getByRole('button', { name: 'Open second.png' })).toBeVisible();
      await backToScan(page);
      await expect(page.getByLabel('Editable source')).toHaveCount(0);
      await openHistory(page);
      await page.getByRole('button', { name: 'Open first.png' }).click();
      await page.getByLabel('Choose image file').setInputFiles(`tests/fixtures/samples/${input}.png`);
      await backToScan(page);
      await expect(page.getByRole('img', { name: `Source: ${input}.png` })).toBeVisible();
      await openHistory(page);
      await page.getByRole('button', { name: 'Delete first.png' }).click();
      const confirmation = page.getByRole('alertdialog', { name: 'Delete scan?' });
      await expect(confirmation).toContainText('first.png');
      await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(confirmation).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Delete first.png' })).toBeFocused();
      await openHistory(page);
      await expect(page.getByRole('button', { name: 'Open first.png' })).toBeVisible();
      await openHistory(page);
      await page.getByRole('button', { name: 'Delete first.png' }).click();
      await confirmation.getByRole('button', { name: 'Delete scan', exact: true }).click();
      await expect(confirmation).toHaveCount(0);
      await openHistory(page);
      await expect(page.getByRole('button', { name: 'Open first.png' })).toHaveCount(0);
      await backToScan(page);
      await expect(page.getByLabel('Editable source')).toHaveCount(0);
      await backToScan(page);
      await expect(page.getByRole('img', { name: `Source: ${input}.png` })).toBeVisible();
      await openHistory(page);
      await page.getByRole('button', { name: 'Clear history', exact: true }).click();
      const clearConfirmation = page.getByRole('alertdialog', { name: 'Clear scan history?' });
      await clearConfirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(clearConfirmation).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Open second.png' })).toBeVisible();
      await page.getByRole('button', { name: 'Clear history', exact: true }).click();
      await clearConfirmation.getByRole('button', { name: 'Clear history', exact: true }).click();
      await expect(clearConfirmation).toHaveCount(0);
      await openHistory(page);
      await expect(page.getByRole('region', { name: 'Scan history' })).toContainText(
        'No saved scans yet',
      );
      await page.evaluate(() => chrome.offscreen.closeDocument());
      await page.reload();
      await openHistory(page);
      await expect(page.getByRole('region', { name: 'Scan history' })).toContainText(
        'No saved scans yet',
      );
      await backToScan(page);
      await expect(page.getByRole('heading', { name: 'What would you like to scan?' })).toBeVisible();
    } finally {
      await extension.close();
    }
  });
}

test('closing the requesting panel during a delayed export does not fail the shared host', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await seed(extension);
    await page.evaluate(async () => {
      const request = indexedDB.open('teximagescan-prototype');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
      const tx = db.transaction('scans', 'readwrite');
      let hold = true;
      window.__releaseExportLock = () => {
        hold = false;
      };
      window.__exportLockDone = new Promise((resolve, reject) => {
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = reject;
      });
      function keepAlive() {
        const read = tx.objectStore('scans').get('first');
        read.onsuccess = () => {
          if (hold) keepAlive();
        };
      }
      keepAlive();
      window.__closingPort = chrome.runtime.connect({ name: 'teximagescan-panel' });
      await new Promise((resolve) => window.__closingPort.onMessage.addListener(resolve));
      window.__closingPort.postMessage({
        type: 'export-history',
        id: 'closed-request',
        ids: ['first'],
        format: 'markdown',
      });
    });
    await openHistory(page);
    await page.getByRole('button', { name: 'Open first.png' }).isEnabled();
    await page.evaluate(() => {
      window.__closingPort.disconnect();
      window.__releaseExportLock();
      return window.__exportLockDone;
    });
    await openSavedScan(page, 'second.png');
    await editSource(page);
    await page.getByLabel('Editable source').fill('$healthy=1$');
    await openHistory(page);
    await expect(page.getByRole('region', { name: 'Scan history' })).toContainText('$healthy=1$');
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await extension.close();
  }
});
