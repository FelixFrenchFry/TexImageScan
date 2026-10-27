import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { openExtension } from './browser.mjs';

// native Chrome shortcuts need a real OS keypress
// renderer keyboard events cannot trigger browser shortcuts
await mkdir('artifacts', { recursive: true });
const server = createServer((_request, response) =>
  response.end(
    '<!doctype html><title>TexImageScan shortcut verification</title><h1>Press Alt+Shift+S to test capture</h1><p>A selection overlay should appear on this page.</p>',
  ),
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const extension = await openExtension({ gpu: false, headless: false });
try {
  const target = await extension.context.newPage();
  await target.goto(`http://127.0.0.1:${server.address().port}/`);
  await target.bringToFront();
  await writeFile(
    'artifacts/shortcut-ready.json',
    JSON.stringify({ title: await target.title(), url: target.url() }),
  );
  console.log('Press Alt+Shift+S in the TexImageScan shortcut verification window.');
  await target.locator('[data-teximagescan-capture]').waitFor({ timeout: 360_000 });
  await target.screenshot({ path: 'artifacts/shortcut-overlay.png' });
  await target.keyboard.press('Escape');
  assert.equal(await target.locator('[data-teximagescan-capture]').count(), 0);
  await writeFile(
    'artifacts/shortcut.json',
    JSON.stringify(
      {
        shortcut: 'Alt+Shift+S',
        activeTabGranted: true,
        overlayDisplayed: true,
        escapeCancelled: true,
        date: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    'Native keyboard shortcut granted access, opened the panel and overlay, and Escape cancelled.',
  );
} finally {
  await extension.close();
  await new Promise((resolve) => server.close(resolve));
}
