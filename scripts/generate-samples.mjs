import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import katex from 'katex';
import { samples } from './lib/samples.ts';
import { browserExecutable } from './browser.mjs';

const target = resolve('tests/fixtures/samples');
await mkdir(target, { recursive: true });
const css = await readFile('node_modules/katex/dist/katex.min.css', 'utf8');
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
const page = await browser.newPage({
  viewport: { width: 1100, height: 900 },
  deviceScaleFactor: 1,
});
// use installed fonts without remote requests
await page.route('http://samples.local/fonts/**', async (route) => {
  const name = new URL(route.request().url()).pathname.split('/').pop();
  await route.fulfill({
    body: await readFile(`node_modules/katex/dist/fonts/${name}`),
    contentType: name.endsWith('woff2') ? 'font/woff2' : 'application/octet-stream',
  });
});
await page.route('http://samples.local/', (route) =>
  route.fulfill({ body: '<html><head></head><body></body></html>', contentType: 'text/html' }),
);
await page.goto('http://samples.local/');
const escape = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const records = [];
try {
  for (const sample of samples) {
    const parts = sample.text.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);
    const html = parts
      .map((part) =>
        part.startsWith('$$')
          ? katex.renderToString(part.slice(2, -2), { displayMode: true })
          : part.startsWith('$')
            ? katex.renderToString(part.slice(1, -1))
            : escape(part),
      )
      .join('');
    await page.setContent(
      `<style>${css}body{margin:0;background:white}#crop{display:inline-block;max-width:850px;padding:30px;font:${sample.id === 'mixed-small' ? 15 : 22}px/1.85 Georgia,serif;white-space:pre-wrap;color:#111}.katex-display{margin:.65em 0}</style><div id="crop">${html}</div>`,
    );
    await page.evaluate(() => document.fonts.ready);
    const screenshot = await page
      .locator('#crop')
      .screenshot({ path: `${target}/${sample.id}.png` });
    const dimensions = await page.locator('#crop').boundingBox();
    records.push({
      ...sample,
      source: 'Controlled browser-rendered fixture',
      renderer: 'KaTeX 0.19.0',
      sha256: createHash('sha256').update(screenshot).digest('hex'),
      width: Math.round(dimensions.width),
      height: Math.round(dimensions.height),
    });
  }
  await page.setContent('<div id="blank" style="width:600px;height:200px;background:white"></div>');
  await page.locator('#blank').screenshot({ path: `${target}/blank.png` });
  await writeFile(`${target}/manifest.json`, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`Generated ${records.length} reference crops`);
} finally {
  await browser.close();
}
