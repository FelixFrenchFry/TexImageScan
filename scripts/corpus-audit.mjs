import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import katex from 'katex';
import { browserExecutable } from './browser.mjs';
import { corpusPath, readCorpus } from './lib/corpus-files.mjs';
import { comparisonSource } from './lib/corpus.mjs';

const { manifest } = await readCorpus();
try {
  await readFile(corpusPath('freeze.json'));
  throw new Error('Corpus is frozen. Open the existing audit sheets instead of overwriting them.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(corpusPath('audit'), { recursive: true });
const css = await readFile('node_modules/katex/dist/katex.min.css', 'utf8');
const escape = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  // load fonts from the local installation
  for (const source of manifest.documents) {
    if (source.importedFrom) {
      for (const extension of ['html', 'png'])
        await copyFile(
          resolve(manifest.protocol.parentDirectory, `audit/${source.id}.${extension}`),
          corpusPath(`audit/${source.id}.${extension}`),
        );
      console.log(`Preserved original audit sheet: ${source.id}`);
      continue;
    }
    const cards = [];
    for (const sample of manifest.cases.filter((c) => c.sourceId === source.id)) {
      const image = (await readFile(corpusPath(sample.image.file))).toString('base64');
      const reference = sample.reference.segments
        .map((s) =>
          s.kind === 'text'
            ? escape(s.text)
            : katex.renderToString(comparisonSource(s.latex), {
                throwOnError: false,
                displayMode: s.display,
              }),
        )
        .join('');
      cards.push(
        `<article><h3>${sample.id}</h3><img src="data:image/png;base64,${image}"><div class="reference">${reference}</div><pre>${escape(sample.reference.segments.map((s) => (s.kind === 'text' ? s.text : `$${s.latex}$`)).join(''))}</pre></article>`,
      );
    }
    const html = `<!doctype html><style>${css.replaceAll('url(fonts/', `url(../../../node_modules/katex/dist/fonts/`)} body{font:16px Georgia;background:#eee;margin:16px}main{display:grid;grid-template-columns:1fr 1fr;gap:12px}article{background:white;padding:12px;min-width:0;break-inside:avoid}h3{font:14px Arial;margin:0 0 14px}img{max-width:100%;max-height:210px;display:block;object-fit:contain;object-position:left top}.reference{border-top:1px solid #aaa;margin-top:15px;padding-top:10px;font-size:16px}pre{font:11px monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:#444}.katex{font-size:1em}</style><h2>${escape(source.title)}: image above, source reference below</h2><main>${cards.join('')}</main>`;
    const path = corpusPath(`audit/${source.id}.html`);
    await writeFile(path, html);
    await page.goto(new URL(`file:///${path.replaceAll('\\', '/')}`).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: corpusPath(`audit/${source.id}.png`), fullPage: true });
    console.log(`Audit sheet: ${source.id}`);
  }
} finally {
  await browser.close();
}
