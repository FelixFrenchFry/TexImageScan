import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { browserExecutable } from '../browser.mjs';

const [html, directory, ...ids] = process.argv.slice(2);
assert.ok(html && directory && ids.length, 'Usage: node capture-audit.ts AUDIT_HTML OUTPUT_DIRECTORY CASE_ID...');
assert.ok(ids.every((id) => /^[a-zA-Z0-9_-]+$/u.test(id)), 'Invalid case ID');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: ['--disable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(pathToFileURL(resolve(html)).href);
  await page.evaluate(() => document.fonts.ready);
  for (const id of ids) {
    const row = page.locator(`article[data-id="${id}"]`);
    assert.equal(await row.count(), 1, `Missing audit case ${id}`);
    await row.screenshot({ path: join(directory, `${id}.png`), animations: 'disabled' });
  }
} finally { await browser.close(); }
