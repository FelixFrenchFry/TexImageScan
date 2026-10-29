import {
  openSettings,
  openHistory,
  openSavedScan,
  backToScan,
  editSource,

} from '../../scripts/lib/panel.mjs';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { openExtension, waitForPanel } from '../../scripts/browser.mjs';

async function seed(extension, count = 2, duplicateNames = false, sources = []) {
  const image = `data:image/png;base64,${(await readFile('tests/fixtures/samples/energy.png')).toString('base64')}`;
  await extension.page.evaluate(
    async ({ image, count, duplicateNames, sources }) => {
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
      for (const [index, scan] of [result, second, ...extra].entries()) {
        if (sources[index] !== undefined) scan.original = scan.edited = sources[index];
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
    { image, count, duplicateNames, sources },
  );
  await extension.page.reload();
  await waitForPanel(extension.page);
  await expect(
    extension.page.getByRole('heading', { name: 'What would you like to scan?' }),
  ).toBeVisible();
}

test('renders wider history previews with a precise timestamp below the filename', async ({}, testInfo) => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    const matrix = String.raw`\[\begin{array}{ll}${Array.from({ length: 8 }, (_, i) =>
      String.raw`\boldsymbol{\Upsilon}^{(${i})} & = \boldsymbol{A}\boldsymbol{x}`,
    ).join(String.raw` \\ `)}\end{array}\]`;
    await seed(extension, 7, false, [
      matrix, 'Energy $E=mc^2$.', '$\\frac{$', '',
      '$$' + Array.from({ length: 40 }, (_, i) => `x_{${i}}`).join('+') + '$$',
      '```latex\nx=1\n```', '<script>alert(1)</script>',
    ]);
    await openHistory(page);
    const history = page.getByRole('region', { name: 'Scan history' });
    const first = history.getByRole('button', { name: 'Open first.png', exact: true });
    await expect(first.locator('.history-preview .katex')).toBeVisible();
    await expect(first.locator('annotation')).toContainText('Upsilon');
    await expect(first.locator('.history-name')).toContainText('first.png');
    const expected = await page.evaluate(() => {
      const date = new Date('2026-10-24T10:00:00Z');
      return {
        date: date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        time: date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
      };
    });
    await expect(first.locator('.history-timestamp')).toHaveText(`${expected.date} · ${expected.time}`);
    await expect(first.locator('time').first()).toHaveAttribute('datetime', '2026-10-24T10:00:00Z');
    await expect(history.locator('[title]')).toHaveCount(0);
    await expect(history.getByRole('button', { name: 'Open second.png' }).locator('.katex')).toBeVisible();
    const invalid = history.getByRole('button', { name: 'Open scan-3.png' });
    await expect(invalid.locator('.history-preview')).toContainText('$\\frac{$');
    await expect(invalid.locator('.katex')).toHaveCount(0);
    await expect(history.getByRole('button', { name: 'Open scan-4.png' })).toContainText('Empty source');
    await expect(history.getByRole('button', { name: 'Open scan-6.png' }).locator('.katex')).toBeVisible();
    await expect(history.getByRole('button', { name: 'Open scan-7.png' })).toContainText('<script>alert(1)</script>');
    await expect(history.locator('script')).toHaveCount(0);
    for (const width of [430, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const geometry = await first.evaluate(button => {
        const timestamp = button.querySelector('.history-timestamp').getBoundingClientRect();
        const name = button.querySelector('.history-name').getBoundingClientRect();
        const formula = button.querySelector('.katex').getBoundingClientRect();
        const preview = button.querySelector('.history-preview').getBoundingClientRect();
        return {
          timestampBelowName: timestamp.top >= name.bottom,
          nameBelowPreview: name.top >= preview.bottom,
          fullWidthPreview: Math.abs(preview.width - button.clientWidth) < 1,
          previewHeight: preview.height,
          formulaFits: formula.top >= preview.top - 1 && formula.bottom <= preview.bottom + 1,
          maxRowHeight: Math.max(...Array.from(document.querySelectorAll('.history-list li'), row => row.getBoundingClientRect().height)),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(geometry).toMatchObject({ timestampBelowName: true, nameBelowPreview: true, fullWidthPreview: true, formulaFits: true, overflow: false });
      expect(geometry.previewHeight).toBeGreaterThanOrEqual(40);
      expect(geometry.maxRowHeight).toBeLessThanOrEqual(110);
      await page.screenshot({ path: testInfo.outputPath(`rendered-history-${width}.png`) });
    }
    await first.click();
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue(matrix);
  } finally {
    await extension.close();
  }
});

test('reopens the retained scan by ID among duplicate filenames in the math workflow', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await seed(extension, 25, true);
    await expect(openSavedScan(page, 'first.png', 'missing')).rejects.toThrow('no longer available');
    await openSavedScan(page, 'first.png', 'first');
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue('$x=2$');
    await editSource(page);
    await page.getByLabel('Editable source').fill('$preserved=321$');
    await page
      .getByLabel('Choose image file')
      .setInputFiles('tests/fixtures/generated/bold-vectors.png');
    await expect(page.getByRole('heading', { name: 'Ready to recognize' })).toBeVisible();
  } finally {
    await extension.close();
  }
});

test('opens, edits and persists scans without bulk selection controls', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await seed(extension);
    await openSettings(page);
    await openHistory(page);
    await page.getByRole('button', { name: 'Open first.png' }).click();
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue('$x=2$');
    await backToScan(page);
    await expect(page.getByRole('img', { name: 'Source: first.png' })).toBeVisible();
    await openSettings(page);
    await editSource(page);
    await page.getByLabel('Editable source').fill('$x=99$');
    await openHistory(page);
    await expect(page.getByRole('button', { name: 'Open first.png' }).locator('.katex annotation')).toHaveText('x=99');
    await openHistory(page);
    const history = page.getByRole('region', { name: 'Scan history' });
    await expect(history.getByRole('checkbox')).toHaveCount(0);
    await expect(history.getByRole('button', { name: /Copy|Select all|Clear selection/ })).toHaveCount(0);
    const second = await extension.context.newPage();
    await second.goto(page.url());
    await openSavedScan(second, 'first.png');
    await editSource(second);
    await expect(second.getByLabel('Editable source')).toHaveValue('$x=99$');
    await openSettings(second);
    await openSettings(second);
    await editSource(second);
    await second.getByLabel('Editable source').fill('$x=100$');
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue('$x=100$');
    await openSettings(second);
    await editSource(page);
    await page.reload();
    await openSavedScan(page, 'first.png');
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue('$x=100$');
    await openHistory(page);
    await page.getByRole('button', { name: 'Open second.png' }).click();
    await openSettings(page);
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

test('paginates larger histories and reopens scans beyond the first page', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await seed(extension, 25);
    await openHistory(page);
    const history = page.getByRole('region', { name: 'Scan history' });
    await openHistory(page);
    await expect(history.getByRole('listitem')).toHaveCount(20);
    await expect(history.getByRole('button', { name: 'Open first.png' })).toHaveCount(0);
    await openHistory(page);
    await history.getByRole('button', { name: 'Show more scans', exact: true }).click();
    await openHistory(page);
    await expect(history.getByRole('listitem')).toHaveCount(25);
    await expect(history.getByRole('button', { name: 'Show more scans' })).toHaveCount(0);
    await history.getByRole('button', { name: 'Open first.png' }).click();
    await editSource(page);
    await expect(page.getByLabel('Editable source')).toHaveValue('$x=2$');
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

test('closing the requesting panel during a queued result read does not fail the shared host', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await seed(extension);
    await openSavedScan(page, 'first.png');
    await page.evaluate(async () => {
      const request = indexedDB.open('teximagescan-prototype');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
      const tx = db.transaction('scans', 'readwrite');
      let hold = true;
      window.__releaseResultLock = () => {
        hold = false;
      };
      window.__resultLockDone = new Promise((resolve, reject) => {
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
      window.__closingPort.postMessage({ type: 'save', id: 'first', text: '$queued=1$' });
      window.__closingPort.postMessage({
        type: 'read-result',
        id: 'closed-request',
        resultId: 'first',
      });
    });
    await openHistory(page);
    await page.getByRole('button', { name: 'Open first.png' }).isEnabled();
    await page.evaluate(() => {
      window.__closingPort.disconnect();
      window.__releaseResultLock();
      return window.__resultLockDone;
    });
    await openSavedScan(page, 'second.png');
    await editSource(page);
    await page.getByLabel('Editable source').fill('$healthy=1$');
    await openHistory(page);
    await expect(page.getByRole('button', { name: 'Open second.png' }).locator('.katex annotation')).toHaveText('healthy=1');
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await extension.close();
  }
});
