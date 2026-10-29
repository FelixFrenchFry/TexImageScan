import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { openExtension } from '../../scripts/browser.mjs';
import { openSavedScan } from '../../scripts/lib/panel.mjs';

async function completed(extension, imagePath = 'tests/fixtures/samples/mixed-energy.png') {
  const image = `data:image/png;base64,${(await readFile(imagePath)).toString('base64')}`;
  await extension.page.evaluate(async (image) => {
    const request = indexedDB.open('teximagescan-prototype');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = reject;
    });
    const result = {
      id: 'focused',
      name: 'summary.png',
      image,
      original: 'A field $A$ at particle $i$.',
      edited: 'A field $A$ at particle $i$.',
      createdAt: new Date().toISOString(),
      elapsedMs: 1200,
      firstTokenMs: 100,
      tokenCount: 25,
      truncated: false,
      gpu: 'fixture',
      modelRevision: 'fixture',
      mode: 'auto',
    };
    const tx = db.transaction('state', 'readwrite');
    tx.objectStore('state').put(
      {
        model: 'missing',
        gpu: null,
        job: { kind: 'idle' },
        capture: { kind: 'idle' },
        result,
        input: { id: result.id, name: result.name, image },
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
  await extension.page.reload();
  await openSavedScan(extension.page, 'summary.png');
  await expect(extension.page.getByRole('heading', { name: 'Copy as' })).toBeVisible();
}

test('rendered PNG and SVG export current edits with portable math and transparent pixels', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await extension.context.grantPermissions(['clipboard-read']);
    await completed(extension);
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page
      .getByLabel('Editable source')
      .fill(
        'Edited energy & force < 3 $E=\\frac{mc^2}{2}$.\n$$\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}$$',
      );
    // export from the edited source while its preview is hidden
    const svgDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
    const svgFile = await svgDownload;
    expect(svgFile.suggestedFilename()).toBe('summary-rendered.svg');
    const svg = await readFile(await svgFile.path(), 'utf8');
    expect(svg).not.toMatch(/<foreignObject|<image|<use|href=|@font-face/);
    const dimensions = await page.evaluate((svg) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (doc.querySelector('parsererror')) throw new Error('Invalid SVG');
      if (!doc.querySelector('path')) throw new Error('Missing math paths');
      if (!doc.documentElement.textContent.includes('Edited')) throw new Error('Missing edits');
      return {
        width: Number(doc.documentElement.getAttribute('width')),
        height: Number(doc.documentElement.getAttribute('height')),
      };
    }, svg);
    const pngDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PNG', exact: true }).click();
    const pngFile = await pngDownload;
    expect(pngFile.suggestedFilename()).toBe('summary-rendered.png');
    const png = await readFile(await pngFile.path());
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(dimensions.width * 2);
    expect(png.readUInt32BE(20)).toBe(dimensions.height * 2);
    await pngFile.saveAs('test-results/rendered-export.png');
    const visual = await extension.context.newPage();
    await visual.setContent(
      `<body style="margin:0;background:white"><img src="data:image/png;base64,${png.toString('base64')}"></body>`,
    );
    await visual.locator('img').evaluate((image) => image.decode());
    await visual.locator('img').screenshot({ path: 'test-results/rendered-export-white.png' });
    await visual.close();
    await page.getByRole('button', { name: 'Copy PNG', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copied PNG' })).toBeVisible();
    const pixels = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((item) => item.types.includes('image/png'));
      if (!item) throw new Error('Missing PNG clipboard image');
      const bitmap = await createImageBitmap(await item.getType('image/png'));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const result = { width: bitmap.width, height: bitmap.height, cornerAlpha: data[3], ink: 0 };
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) result.ink++;
      bitmap.close();
      return result;
    });
    expect(pixels.width).toBe(dimensions.width * 2);
    expect(pixels.height).toBe(dimensions.height * 2);
    expect(pixels.cornerAlpha).toBe(0);
    expect(pixels.ink).toBeGreaterThan(500);
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('group', { name: 'Rendered image exports' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/rendered-image-actions.png', fullPage: true });
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page.getByLabel('Editable source').fill('');
    for (const name of ['Copy PNG', 'Download PNG', 'Download SVG'])
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  } finally {
    await extension.close();
  }
});

test('image export reports invalid math and does not clip wide equations', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await completed(extension);
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page.getByLabel('Editable source').fill('$$\\frac{$$');
    await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
    await expect(
      page.getByText('Fix the highlighted math in Edit source before exporting an image.', {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel('Editable source').fill(`$$${'x+'.repeat(70)}1$$`);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
    const svg = await readFile(await (await download).path(), 'utf8');
    const fits = await page.evaluate((svg) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const width = Number(doc.documentElement.getAttribute('width'));
      const math = doc.querySelector('svg svg');
      return (
        width > 640 && Number(math.getAttribute('x')) + Number(math.getAttribute('width')) < width
      );
    }, svg);
    expect(fits).toBe(true);
  } finally {
    await extension.close();
  }
});

test('rendered equations stay centered and separate after layout is serialized', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await completed(extension);
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page
      .getByLabel('Editable source')
      .fill('A short sentence.\n$$\\frac{a}{b}$$$$\\frac{c}{d}$$$$\\frac{e}{f}$$');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
    const svg = await readFile(await (await download).path(), 'utf8');
    const layout = await page.evaluate((svg) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      return {
        width: Number(doc.documentElement.getAttribute('width')),
        equations: [...doc.querySelectorAll('svg svg')].map((eq) => ({
          x: Number(eq.getAttribute('x')),
          y: Number(eq.getAttribute('y')),
          width: Number(eq.getAttribute('width')),
          height: Number(eq.getAttribute('height')),
        })),
      };
    }, svg);
    expect(layout.equations).toHaveLength(3);
    for (let i = 0; i < layout.equations.length; i++) {
      const eq = layout.equations[i];
      expect.soft(Math.abs(eq.x + eq.width / 2 - layout.width / 2)).toBeLessThan(1);
      if (i > 0)
        expect
          .soft(eq.y)
          .toBeGreaterThan(layout.equations[i - 1].y + layout.equations[i - 1].height);
    }
  } finally {
    await extension.close();
  }
});

test('Unicode inside math fits inside the exported SVG viewport', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await completed(extension);
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page.getByLabel('Editable source').fill('$$\\text{ЖЖЖЖ}$$');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
    const svg = await readFile(await (await download).path(), 'utf8');
    const geometry = await page.evaluate((svg) => {
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const root = document.importNode(parsed.documentElement, true);
      root.style.cssText = 'position:fixed;visibility:hidden';
      document.body.append(root);
      try {
        const math = root.querySelector('svg');
        const box = math.getBBox(),
          viewport = math.viewBox.baseVal;
        return {
          right: box.x + box.width,
          bottom: box.y + box.height,
          left: box.x,
          top: box.y,
          viewportRight: viewport.x + viewport.width,
          viewportBottom: viewport.y + viewport.height,
          viewportLeft: viewport.x,
          viewportTop: viewport.y,
        };
      } finally {
        root.remove();
      }
    }, svg);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportRight + 1);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportBottom + 1);
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.viewportLeft - 1);
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.viewportTop - 1);
  } finally {
    await extension.close();
  }
});

test('Focused result edits and copies through direct format actions with light appearance', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await extension.context.grantPermissions(['clipboard-read']);
    await completed(extension);
    await expect(page.getByRole('heading', { name: 'Copy as' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Overlay', exact: true })).toHaveCount(0);
    await expect(page.locator('.preview .katex').first()).toBeVisible();
    await expect(page.getByLabel('Editable source')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Recognition mode', exact: true })).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page.getByLabel('Editable source').fill('A corrected field $A_i$.');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.locator('.preview')).toContainText('A corrected field');
    await page.getByRole('button', { name: 'Copy Markdown with math', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('A corrected field $A_i$.');
    await expect(page.getByRole('status').filter({ hasText: 'Copied Markdown' })).toBeVisible();
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(
      await page.locator('.radix-themes').evaluate((el) => getComputedStyle(el).colorScheme),
    ).toBe('light');
    await page.screenshot({ path: 'test-results/focused-result.png', fullPage: true });
  } finally {
    await extension.close();
  }
});

test('settings and history have their own views and keep a staged crop and completed result', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await completed(extension);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Back to scan', exact: true }).click();
    await page.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/integral.png');
    await expect(page.getByRole('heading', { name: 'Ready to recognize' })).toBeVisible();
    await expect(
      page.getByRole('img', { name: 'Source: integral.png', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('img', { name: 'Source: summary.png', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Scan history', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Scan history' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to scan', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ready to recognize' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Back to scan', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await extension.close();
  }
});

test('uploading the same file again stages a new recognition and preserves the saved result', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await completed(extension);
    const second = await extension.context.newPage();
    await second.goto(page.url());
    await openSavedScan(second, 'summary.png');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Choose image file').setInputFiles({
      name: 'summary.png',
      mimeType: 'image/png',
      buffer: await readFile('tests/fixtures/samples/mixed-energy.png'),
    });
    for (const panel of [page, second]) {
      await expect(panel.getByRole('heading', { name: 'Ready to recognize' })).toBeVisible();
      await expect(panel.getByRole('region', { name: 'Previous result' })).toContainText('A field');
    }
  } finally {
    await extension.close();
  }
});

test('long inline math remains contained at narrow panel widths', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await completed(extension);
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page
      .getByLabel('Editable source')
      .fill(`A long expression $\\frac{${'x'.repeat(160)}}{n}$.`);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(page.locator('.preview .katex')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await extension.close();
  }
});

test('each direct copy format preserves its export semantics and empty edits disable copying', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await extension.context.grantPermissions(['clipboard-read']);
    await completed(extension);
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page.getByLabel('Editable source').fill('$$x=3$$');
    for (const [format, expected] of [
      ['Markdown with math', '$$x=3$$'],
      ['LaTeX', 'x=3'],
      ['Plain text', '$$x=3$$'],
    ]) {
      await page.getByRole('button', { name: `Copy ${format}`, exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
      await expect(page.getByRole('status').filter({ hasText: `Copied ${format}` })).toBeVisible();
    }
    await page.getByLabel('Editable source').fill('');
    await expect(page.getByRole('heading', { name: 'Source is empty' })).toBeVisible();
    for (const format of ['Markdown with math', 'LaTeX', 'Plain text'])
      await expect(
        page.getByRole('button', { name: `Copy ${format}`, exact: true }),
      ).toBeDisabled();
    await page.getByRole('button', { name: 'Reset edits', exact: true }).click();
    await expect(page.getByLabel('Editable source')).toHaveValue('A field $A$ at particle $i$.');
  } finally {
    await extension.close();
  }
});

test('the light result uses readable text, icon and control contrast', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await completed(extension);
    const ratios = await page.evaluate(() => {
      const rgb = (color) =>
        color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number);
      const luminance = (color) =>
        rgb(color)
          .map((value) => {
            value /= 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => {
        const x = luminance(a),
          y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const read = (selector) => getComputedStyle(document.querySelector(selector));
      const main = read('main'),
        preview = read('.preview'),
        header = read('.app-header'),
        status = read('.model-status'),
        copy = read('.copy-format'),
        original = read('.original-image');
      return {
        text: ratio(preview.color, preview.backgroundColor),
        secondary: ratio(status.color, header.backgroundColor),
        copy: ratio(copy.color, copy.backgroundColor),
        border: ratio(original.borderTopColor, original.backgroundColor),
      };
    });
    expect(ratios.text).toBeGreaterThanOrEqual(4.5);
    expect(ratios.secondary).toBeGreaterThanOrEqual(4.5);
    expect(ratios.copy).toBeGreaterThanOrEqual(4.5);
    expect(ratios.border).toBeGreaterThanOrEqual(3);
  } finally {
    await extension.close();
  }
});

test('copy rows preview exactly what each format copies and fit narrow panels', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await extension.context.grantPermissions(['clipboard-read']);
    await completed(extension);
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page.getByLabel('Editable source').fill('$$x=3$$');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    for (const [format, expected] of [
      ['LaTeX', 'x=3'],
      ['Markdown with math', '$$x=3$$'],
      ['Plain text', '$$x=3$$'],
    ]) {
      const action = page.getByRole('button', { name: `Copy ${format}`, exact: true });
      await expect(action.locator('code')).toHaveText(expected);
      await action.click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
      await expect(action).toContainText('Copied');
    }
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/check-and-copy.png', fullPage: true });
  } finally {
    await extension.close();
  }
});

test('Original and Rendered switch only the preview while the previous editing and copy UI remains', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await completed(extension);
    await expect(page.getByRole('button', { name: 'Rendered', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Original', exact: true }).click();
    await expect(
      page.getByRole('img', { name: 'Original preview: summary.png', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.preview')).not.toBeVisible();
    await expect(page.getByRole('img', { name: 'Source: summary.png', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Rendered', exact: true }).click();
    await expect(page.locator('.preview .katex').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Expand preview', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.locator('.copy-format')).toHaveCount(3);
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page.getByLabel('Editable source').fill('A correction $x=2$.');
    await expect(page.getByRole('group', { name: 'Preview mode', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.locator('.preview')).toContainText('A correction');
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/preview-switch-only.png', fullPage: true });
  } finally {
    await extension.close();
  }
});

test('switching preview modes keeps the frame and copy controls in place', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await completed(extension, 'tests/fixtures/samples/matrix.png');
    for (const width of [430, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      for (const text of ['$$x=1$$', 'A field $A$ at particle $i$.\n'.repeat(12)]) {
        await page.getByRole('button', { name: 'Edit source', exact: true }).click();
        await page.getByLabel('Editable source').fill(text);
        await page.getByRole('button', { name: 'Preview', exact: true }).click();
        await page.evaluate(() => document.fonts.ready);
        const frame = page.locator('.result-box');
        const geometry = () =>
          page.evaluate(() => {
            const frame = document.querySelector('.result-box').getBoundingClientRect();
            const copy = document.querySelector('.copy-formats').getBoundingClientRect();
            return {
              width: frame.width,
              height: frame.height,
              copyTop: copy.top + document.querySelector('main').scrollTop,
            };
          });
        await frame.scrollIntoViewIfNeeded();
        const before = await geometry();
        for (const mode of ['Original', 'Rendered', 'Original', 'Rendered']) {
          await page.getByRole('button', { name: mode, exact: true }).click();
          await expect.poll(geometry).toEqual(before);
          await expect(
            page.locator(mode === 'Original' ? '.preview-original' : '.preview'),
          ).toBeVisible();
          await expect(
            page.locator(mode === 'Original' ? '.preview' : '.preview-original'),
          ).not.toBeVisible();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    }
  } finally {
    await extension.close();
  }
});
