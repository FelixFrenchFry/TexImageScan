import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import katex from 'katex';
import { z } from 'zod';
import { browserExecutable } from '../browser.mjs';
import { sha256 } from './dataset.ts';
import { formulaFamily, mathManifestSchema, validateMathCases, type MathCase } from './manifest.ts';

const root = 'tests/math-benchmark';
try { await access(`${root}/manifest.json`); throw new Error('Already captured. Use a separate benchmark version instead of replacing its references.'); }
catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
await mkdir(`${root}/images`, { recursive: true });
await mkdir(`${root}/sources`, { recursive: true });
const corpus = z.object({ documents: z.array(z.object({ id: z.string(), url: z.url(), license: z.string() })),
  cases: z.array(z.object({ id: z.string(), kind: z.string(), split: z.string(), sourceId: z.string(), documentId: z.string(), tags: z.array(z.string()),
    image: z.object({ file: z.string(), sha256: z.string(), width: z.number(), height: z.number() }),
    reference: z.object({ status: z.literal('source-checked'), segments: z.array(z.object({ kind: z.literal('math'), latex: z.string(), display: z.boolean() })) }).or(z.unknown()) })) })
  .parse(JSON.parse(await readFile('tests/corpus-v2/manifest.json', 'utf8')));
const cases: MathCase[] = [];
for (const sample of corpus.cases.filter(row => row.kind === 'equation' && row.split === 'development')) {
  const document = corpus.documents.find(row => row.id === sample.sourceId); assert.ok(document);
  const reference = mathManifestSchema.shape.cases.element.shape.reference.parse(sample.reference);
  const first = reference.segments[0]; assert.ok(first);
  cases.push({ id: sample.id, split: 'development', documentId: sample.documentId, familyId: formulaFamily(first.latex),
    tags: sample.tags, image: { ...sample.image, file: `tests/corpus-v2/${sample.image.file}` }, reference,
    source: { url: document.url, license: document.license, previouslyEvaluated: true }, acquisition: { kind: 'publisher', scale: 1 } });
}
assert.equal(cases.length, 80);
const knownFamilies = new Set(cases.map(row => row.familyId));
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1400 }, deviceScaleFactor: 1 });
const documents = [
  { title: "Hamilton's_equations", split: 'heldout', count: 8 },
  { title: 'Christoffel_symbols', split: 'heldout', count: 8 },
  { title: 'Einstein_field_equations', split: 'heldout', count: 8 },
  { title: 'Navier%E2%80%93Stokes_equations', split: 'heldout', count: 8 },
  { title: 'Matrix_multiplication', split: 'development', count: 8 },
] as const;
const exclusions: { document: string; reason: string }[] = [];
try {
  for (const document of documents) {
    const url = `https://en.wikipedia.org/wiki/${document.title}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.evaluate(() => window.document.fonts.ready);
    const html = await page.content();
    const snapshotSha256 = sha256(html);
    await writeFile(`${root}/sources/${document.title}.html.gz`, gzipSync(html));
    const revisionUrl = await page.locator('#t-permalink a').getAttribute('href').catch(() => null);
    const locators = page.locator('.mw-parser-output .mwe-math-element');
    let selected = 0;
    for (let index = 0; index < await locators.count() && selected < document.count; index++) {
      const locator = locators.nth(index);
      const target = locator.locator('img[alt]').first();
      const latex = await target.getAttribute('alt').catch(() => null);
      if (!latex || latex.length < 24 || latex.length > 1500) continue;
      const familyId = formulaFamily(latex);
      if (document.split === 'heldout' && (knownFamilies.has(familyId) || cases.some(row => row.familyId === familyId))) continue;
      try { katex.renderToString(latex, { throwOnError: true, strict: 'ignore', trust: false }); }
      catch { exclusions.push({ document: url, reason: `Unsupported reference renderer: ${latex}` }); continue; }
      if (!await target.isVisible()) continue;
      const box = await target.boundingBox();
      if (!box || box.width < 70 || box.height < 20 || box.width > 1100 || box.height > 500) continue;
      const id = `${document.title.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}-${String(++selected).padStart(2, '0')}`;
      // CSS zoom renders the source SVG again at the requested size
      for (const scale of document.split === 'development' ? [1, 2] : [1]) {
        await target.evaluate((element, scale) => { element.style.zoom = String(scale); }, scale);
        const image = await target.screenshot({ animations: 'disabled' });
        const file = `${root}/images/${id}-zoom-${scale}.png`;
        await writeFile(file, image);
        cases.push({ id: `${id}-zoom-${scale}`, split: document.split,
          documentId: document.split === 'development' ? 'wikipedia-Matrix_multiplication' : `wikipedia-${document.title}`,
          familyId, tags: ['publisher', 'printed', document.split === 'development' ? 'source-zoom' : 'fresh-source'],
          image: { file, sha256: sha256(image), width: image.readUInt32BE(16), height: image.readUInt32BE(20) },
          reference: { status: 'source-checked', segments: [{ kind: 'math', latex, display: true }] },
          source: { url, license: 'CC-BY-SA-4.0', previouslyEvaluated: document.split === 'development', snapshotSha256,
            ...(revisionUrl ? { revisionUrl: new URL(revisionUrl, url).href } : {}) },
          acquisition: { kind: 'publisher', scale } });
      }
      await target.evaluate(element => { element.style.zoom = '1'; });
    }
    assert.ok(selected >= 1, `No usable math crops: ${url}`);
    console.log(`${document.title}: ${selected} equations`);
  }
} finally { await browser.close(); }
validateMathCases(cases);
const manifest = mathManifestSchema.parse({ version: 1, purpose: 'printed-math', cases,
  limitations: ['Printed publisher formulas only. Source references come from author TeX/MathML, not recognition outputs.',
    'The 80 inherited development cases and their sources were previously evaluated. Earlier heldout reports are historical and excluded here.',
    'New heldout pages were selected and captured before inference. Documents, normalized formula families and identical images cannot cross splits.',
    'The source-zoom pairs re-rasterize live browser math at CSS zoom 1 and 2. They measure browser source detail, not PDF zoom or digital PNG upsampling.',
    'KaTeX-unsupported references and crops outside the capture size bounds are excluded; the corpus is not an unbiased population estimate.'] });
await writeFile(`${root}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
await writeFile(`${root}/capture.json`, JSON.stringify({ capturedAt: new Date().toISOString(), browser: 'Chrome',
  scriptSha256: sha256(await readFile('scripts/math-benchmark/capture.ts')), exclusions }, null, 2) + '\n');
await writeFile(`${root}/NOTICE.md`, '# Printed math benchmark attribution\n\nInherited development images retain the source licenses in [corpus-v2](../corpus-v2/NOTICE.md).\n\nNew Wikipedia equation crops and source snapshots are attributed to the contributors of each linked article under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Captures crop the equation and, for development pairs, change browser zoom. Source/revision URLs and snapshot hashes are recorded in manifest.json.\n\n' + documents.map(row => `- [${decodeURIComponent(row.title).replaceAll('_', ' ')}](https://en.wikipedia.org/wiki/${row.title})`).join('\n') + '\n');
console.log(JSON.stringify({ cases: cases.length, heldout: cases.filter(row => row.split === 'heldout').length }));
