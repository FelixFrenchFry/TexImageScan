import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import katex from 'katex';
import { browserExecutable } from './browser.mjs';

const directory = 'tests/fixtures/generated';
const source = String.raw`\nabla f(\boldsymbol{x}_1+\boldsymbol{x}_2)=\boldsymbol{x}_3-\boldsymbol{x}_4`;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 400 },
    deviceScaleFactor: 1,
  });
  await page.route('http://fixtures.local/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    await route.fulfill(
      name
        ? {
            body: await readFile(`node_modules/katex/dist/fonts/${name}`),
            contentType: 'font/woff2',
          }
        : {
            body: '<!doctype html><html><head></head><body></body></html>',
            contentType: 'text/html',
          },
    );
  });
  await page.goto('http://fixtures.local/');
  const css = await readFile('node_modules/katex/dist/katex.min.css', 'utf8');
  await page.setContent(
    `<style>${css}body{margin:0;background:white}#crop{display:inline-block;padding:24px;font-size:24px;color:#111}</style><div id="crop">${katex.renderToString(source, { displayMode: true, trust: false })}</div>`,
  );
  await page.evaluate(() => document.fonts.ready);
  const png = await page.locator('#crop').screenshot({ path: `${directory}/bold-vectors.png` });
  await writeFile(
    `${directory}/manifest.json`,
    JSON.stringify(
      {
        id: 'bold-vectors',
        source: 'Original synthetic expression defined in scripts/generate-test-fixtures.mjs',
        latex: source,
        renderer: `KaTeX ${katex.version}`,
        sha256: createHash('sha256').update(png).digest('hex'),
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser.close();
}
