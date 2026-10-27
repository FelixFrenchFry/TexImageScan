import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { browserExecutable } from './browser.mjs';

const records = JSON.parse(await readFile('tests/fixtures/samples/manifest.json', 'utf8')).filter(
  (sample) => !sample.id.startsWith('web-'),
);
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
const page = await browser.newPage({
  viewport: { width: 1200, height: 1000 },
  deviceScaleFactor: 1,
});
try {
  for (const sample of [
    {
      id: 'web-equation',
      kind: 'equation',
      label: 'Wikipedia quadratic formula',
      url: 'https://en.wikipedia.org/wiki/Quadratic_formula',
    },
    {
      id: 'web-passage',
      kind: 'mixed',
      label: 'Wikipedia mixed passage',
      url: 'https://en.wikipedia.org/wiki/Pythagorean_theorem',
    },
  ]) {
    await page.goto(sample.url, { waitUntil: 'domcontentloaded' });
    const locator =
      sample.kind === 'equation'
        ? page.locator('.mw-parser-output .mwe-math-element img[alt*="sqrt"]').first()
        : page
            .locator('.mw-parser-output p')
            .filter({ has: page.locator('.mwe-math-element') })
            .first();
    await locator.waitFor({ state: 'visible' });
    await locator.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    const text = await locator.evaluate((element) => {
      if (element instanceof HTMLImageElement) return `$$${element.alt}$$`;
      const copy = element.cloneNode(true);
      for (const reference of copy.querySelectorAll('.reference')) reference.remove();
      for (const math of copy.querySelectorAll('.mwe-math-element')) {
        const source = math.querySelector('img')?.getAttribute('alt');
        if (source) math.replaceWith(document.createTextNode(`$${source}$`));
      }
      if (copy.classList.contains('mwe-math-element'))
        return `$$${copy.querySelector('img')?.getAttribute('alt')}$$`;
      return copy.textContent.replace(/\s+/g, ' ').trim();
    });
    const bounds = await locator.boundingBox();
    // exclude the adjacent infobox from this paragraph crop
    const infobox =
      sample.kind === 'mixed' ? await page.locator('.infobox').first().boundingBox() : null;
    const width =
      infobox && infobox.x > bounds.x && infobox.x < bounds.x + bounds.width
        ? infobox.x - bounds.x - 12
        : bounds.width;
    const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    const bytes = await page.screenshot({
      path: `tests/fixtures/samples/${sample.id}.png`,
      clip: { x: bounds.x + scroll.x, y: bounds.y + scroll.y, width, height: bounds.height },
    });
    records.push({
      ...sample,
      text,
      source: sample.url,
      renderer: 'Live Wikipedia page screenshot',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: Math.round(width),
      height: Math.round(bounds.height),
    });
    console.log(`${sample.id}: ${text}`);
  }
  await page.setContent('<div id="blank" style="width:600px;height:200px;background:white"></div>');
  await page.locator('#blank').screenshot({ path: 'tests/fixtures/samples/blank.png' });
  await writeFile('tests/fixtures/samples/manifest.json', `${JSON.stringify(records, null, 2)}\n`);
} finally {
  await browser.close();
}
