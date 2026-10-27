import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { browserExecutable } from './browser.mjs';

const master = await readFile('assets/logo/teximagescan.svg', 'utf8');
const small = await readFile('assets/logo/teximagescan-small.svg', 'utf8');
const sourceFor = (size) => (size <= 32 ? small : master);
const iconSizes = [16, 32, 48, 128];
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [...iconSizes, 512, 1024]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${sourceFor(size)}`,
    );
    await page.screenshot({ path: `assets/logo/teximagescan-${size}.png`, omitBackground: true });
  }

  await mkdir('public/icon', { recursive: true });
  for (const size of iconSizes)
    await copyFile(`assets/logo/teximagescan-${size}.png`, `public/icon/${size}.png`);
  await copyFile('assets/logo/teximagescan.svg', 'public/icon/logo.svg');

  // preview toolbar icons at their actual sizes on light and dark backgrounds
  const png = async (size) =>
    `data:image/png;base64,${(await readFile(`public/icon/${size}.png`)).toString('base64')}`;
  const shots = { 16: await png(16), 32: await png(32), 48: await png(48), 128: await png(128) };
  const rows = ['#ffffff', '#808080', '#202124']
    .map(
      (background) =>
        `<section style="background:${background}">${iconSizes.map((size) => `<div><img src="${shots[size]}" width="${size}" height="${size}"><label>${size} px</label></div>`).join('')}</section>`,
    )
    .join('');
  await page.setViewportSize({ width: 640, height: 540 });
  await page.setContent(
    `<style>body{margin:0;font:13px system-ui}section{display:flex;align-items:center;justify-content:space-around;height:180px}div{display:flex;flex-direction:column;align-items:center;gap:12px;width:140px}img{display:block}label{background:white;color:#111;padding:2px 6px;border-radius:4px}</style>${rows}`,
  );
  await page.screenshot({ path: 'assets/logo/toolbar-preview.png' });
} finally {
  await browser.close();
}
console.log('Rendered the logo and updated public/icon');
