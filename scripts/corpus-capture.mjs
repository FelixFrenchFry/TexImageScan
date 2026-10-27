import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { browserExecutable } from './browser.mjs';
import { corpusArgs, corpusRoot } from './lib/corpus-files.mjs';
import { compareMath } from './lib/corpus.mjs';
import {
  collectCandidates,
  removeCaptureExclusions,
  captureBounds,
} from './lib/corpus-candidates.mjs';

const root = corpusRoot;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originalSources = [
  ...['linear-algebra', 'calculus', 'probability'].map((slug) => ({
    id: `d2l-${slug}`,
    family: 'd2l-en',
    publisher: 'D2L',
    split: 'development',
    adapter: 'mathjax',
    url: `https://d2l.ai/chapter_preliminaries/${slug}.html`,
    counts: { equation: 5, mixed: 3, text: 2 },
    license: 'CC-BY-SA-4.0',
    licenseUrl: 'https://github.com/d2l-ai/d2l-en/blob/master/LICENSE',
    authors: 'Aston Zhang, Zachary C. Lipton, Mu Li, Alexander J. Smola',
  })),
  {
    id: 'd2l-gd',
    family: 'd2l-en',
    publisher: 'D2L',
    split: 'development',
    adapter: 'mathjax',
    url: 'https://d2l.ai/chapter_optimization/gd.html',
    counts: { equation: 5, mixed: 3, text: 2 },
    license: 'CC-BY-SA-4.0',
    licenseUrl: 'https://github.com/d2l-ai/d2l-en/blob/master/LICENSE',
    authors: 'Aston Zhang, Zachary C. Lipton, Mu Li, Alexander J. Smola',
  },
  ...[
    'Gradient',
    'Normal_distribution',
    'Bayes%27_theorem',
    'Euler%27s_formula',
    'Fourier_transform',
    'Taylor_series',
  ].map((slug) => ({
    id: `wiki-${decodeURIComponent(slug).toLowerCase().replaceAll("'", '').replaceAll('_', '-')}`,
    family: `wikipedia-${slug}`,
    publisher: 'Wikipedia',
    split: 'heldout',
    adapter: 'wiki',
    url: `https://en.wikipedia.org/wiki/${slug}`,
    counts: { equation: 5, mixed: 3, text: 2 },
    license: 'CC-BY-SA-4.0',
    licenseUrl: 'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content',
    authors: 'Wikipedia contributors; revision and history link recorded below',
  })),
  ...['eigenvectors', 'least-squares', 'row-reduction'].map((slug) => ({
    id: `ila-${slug}`,
    family: 'ila',
    publisher: 'ILA',
    split: 'heldout',
    adapter: 'prose',
    url: `https://textbooks.math.gatech.edu/ila/${slug}.html`,
    counts: { text: slug === 'eigenvectors' ? 4 : 3 },
    license: 'GFDL-1.2-or-later',
    licenseUrl: 'https://textbooks.math.gatech.edu/ila/colophon-1.html',
    authors: 'Dan Margalit and Joseph Rabinoff',
  })),
  ...['1001102', '1008462'].map((number) => ({
    id: `plos-${number}`,
    family: `doi:10.1371/journal.pcbi.${number}`,
    publisher: 'PLOS',
    split: 'development',
    adapter: 'prose',
    url: `https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.${number}`,
    counts: { text: 5 },
    license: 'CC-BY-4.0',
    licenseUrl: 'https://journals.plos.org/plosone/s/licenses-and-copyright',
    authors: 'Article authors listed in the archived source and linked DOI',
  })),
];
const sourceFile = corpusArgs.includes('--sources')
  ? corpusArgs[corpusArgs.indexOf('--sources') + 1]
  : null;
const sources = sourceFile ? JSON.parse(await readFile(sourceFile, 'utf8')) : originalSources;
const only = corpusArgs.includes('--source')
  ? corpusArgs[corpusArgs.indexOf('--source') + 1].split(',')
  : null;
const manifest = corpusArgs.includes('--resume')
  ? JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'))
  : {
      version: 1,
      createdAt: new Date().toISOString(),
      referencePolicy:
        'Document-authored DOM text and original TeX, never TeleOCR output. Source-checked; see audit.json for visual checks.',
      documents: [],
      cases: [],
    };
if (only) {
  manifest.documents = manifest.documents.filter((d) => !only.includes(d.id));
  manifest.cases = manifest.cases.filter((c) => !only.includes(c.sourceId));
}
await Promise.all(
  ['images', 'sources', 'licenses'].map((dir) => mkdir(`${root}/${dir}`, { recursive: true })),
);
try {
  await readFile(`${root}/freeze.json`);
  throw new Error(
    'Corpus is frozen. Keep these references and create a separate corpus version for new captures.',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  for (const source of sources) {
    if (only && !only.includes(source.id)) continue;
    if (manifest.documents.some((document) => document.id === source.id)) {
      console.log(`Keeping captured ${source.id}`);
      continue;
    }
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
      deviceScaleFactor: 1,
    });
    try {
      const response = await page.goto(source.url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      const originalHtml = await response.text();
      await page.waitForFunction(() => document.querySelectorAll('p').length > 20, {
        timeout: 30000,
      });
      if (source.adapter === 'mathjax')
        await page.waitForFunction(() => window.MathJax?.startup?.document?.math, null, {
          timeout: 45000,
        });
      if (source.adapter === 'mathjax2')
        await page.waitForFunction(() => window.MathJax?.Hub?.getAllJax?.().length, null, {
          timeout: 45000,
        });
      if (source.adapter === 'mathjax2')
        await page.evaluate(() => new Promise((resolve) => window.MathJax.Hub.Queue(resolve)));
      if (source.adapter === 'katex')
        await page.waitForFunction(() => document.querySelector('.katex annotation'), null, {
          timeout: 45000,
        });
      if (source.adapter === 'mathml')
        await page.waitForFunction(() => document.querySelector('math[alttext]'), null, {
          timeout: 45000,
        });
      await page.evaluate(async () => {
        if (window.MathJax?.startup?.promise) await window.MathJax.startup.promise;
        await document.fonts.ready;
      });
      // remove citation markers from both the reference and captured image
      await page.evaluate(removeCaptureExclusions);
      if (source.publisher === 'PLOS')
        await page.addStyleTag({
          content: '.reveal-modal-bg, .reveal-modal { display: none !important; }',
        });
      if (source.publisher === 'PLOS')
        await page.evaluate(() => {
          for (const element of document.querySelectorAll('body *')) {
            const bounds = element.getBoundingClientRect();
            if (
              getComputedStyle(element).position === 'fixed' &&
              bounds.width >= innerWidth * 0.9 &&
              bounds.height >= innerHeight * 0.9
            )
              element.style.setProperty('display', 'none', 'important');
          }
        });
      const html = await page.content();
      const documentRecord = {
        ...source,
        title: await page.title(),
        capturedAt: new Date().toISOString(),
        htmlSha256: sha(html),
        snapshot: `sources/${source.id}.html.gz`,
        modifications: [
          'Citation markers, edit controls, and equation numbers removed before extraction and screenshot.',
        ],
      };
      const authors = await page
        .locator('meta[name="citation_author"]')
        .evaluateAll((nodes) => nodes.map((node) => node.content));
      if (authors.length) documentRecord.authors = authors;
      documentRecord.typography = await page.evaluate(() => ({
        bodyFont: getComputedStyle(
          document.querySelector('main p,article p,d-article p,p') ?? document.body,
        ).fontFamily,
        viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
      }));
      if (source.licenseEvidenceUrl) {
        const evidence = await page.request.get(source.licenseEvidenceUrl);
        if (!evidence.ok()) throw new Error(`Cannot verify license: ${source.id}`);
        const text = await evidence.text();
        if (!text.includes('creativecommons.org/licenses/by/4.0/'))
          throw new Error(`Expected CC BY 4.0 paper license: ${source.id}`);
        documentRecord.licenseSnapshot = `sources/${source.id}.license.html.gz`;
        documentRecord.licenseHtmlSha256 = sha(text);
        await writeFile(`${root}/${documentRecord.licenseSnapshot}`, gzipSync(text));
      }
      Object.assign(documentRecord, {
        originalSnapshot: `sources/${source.id}.original.html.gz`,
        originalHtmlSha256: sha(originalHtml),
      });
      await writeFile(`${root}/${documentRecord.originalSnapshot}`, gzipSync(originalHtml));
      if (source.adapter === 'wiki')
        Object.assign(
          documentRecord,
          await page.evaluate(() => ({
            revision:
              document.querySelector('meta[property="mw:revisionSHA1"]')?.content ??
              document.querySelector('body')?.getAttribute('data-mw-ve-target-container'),
            revisionId:
              window.mw?.config?.get('wgRevisionId') ??
              document.documentElement.getAttribute('about')?.match(/revision\/(\d+)/)?.[1] ??
              document.querySelector('a[href*="oldid="]')?.href.match(/oldid=(\d+)/)?.[1],
            history: location.href.replace('/wiki/', '/w/index.php?title=') + '&action=history',
          })),
        );
      await writeFile(`${root}/${documentRecord.snapshot}`, gzipSync(html));
      const candidates = await page.evaluate(collectCandidates, source);
      const supported = candidates.filter((candidate) =>
        candidate.segments
          .filter((s) => s.kind === 'math')
          .every((span) => compareMath(span.latex, span.latex, span.display).referenceRenderable),
      );
      const chosenTargets = [];
      for (const [kind, count] of Object.entries(source.counts)) {
        let available = supported.filter((c) => c.kind === kind);
        if (kind === 'equation') {
          const separate = available.filter(
            (equation) =>
              !supported.some(
                (passage) =>
                  passage.kind === 'mixed' &&
                  passage.html.includes(`data-corpus-target="${equation.target}"`),
              ),
          );
          if (separate.length >= count) available = separate;
        }
        if (available.length < count)
          throw new Error(`${source.id}: need ${count} ${kind}, found ${available.length}`);
        // spread selections across the document
        const spread = Array.from(
          { length: count },
          (_, index) => available[Math.floor((index * available.length) / count)],
        );
        const ordered = [
          ...spread,
          ...available.filter((candidate) => !spread.includes(candidate)),
        ];
        let captured = 0;
        for (const candidate of ordered) {
          if (captured === count) break;
          const id = `${source.id}-${kind}-${String(captured + 1).padStart(2, '0')}`;
          const locator = page.locator(`[data-corpus-target="${candidate.target}"]`);
          if (!(await locator.isVisible())) continue;
          const overlaps = await locator.evaluate(
            (element, selected) =>
              selected.some((target) => {
                const other = document.querySelector(`[data-corpus-target="${target}"]`);
                return (
                  other && (element === other || element.contains(other) || other.contains(element))
                );
              }),
            chosenTargets,
          );
          if (overlaps) continue;
          await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
          await locator.evaluate(async (el) => {
            for (const image of el.querySelectorAll('img'))
              if (!image.complete)
                await new Promise((resolve) => {
                  image.onload = resolve;
                  image.onerror = resolve;
                });
          });
          console.log(`Capturing ${id}`);
          const legacyMath = source.adapter === 'mathjax2' && kind === 'equation';
          const clip = legacyMath ? await locator.evaluate(captureBounds) : undefined;
          const screenshotOptions = { path: `${root}/images/${id}.png`, animations: 'disabled' };
          const bytes = legacyMath
            ? await page.screenshot({ ...screenshotOptions, clip, fullPage: true })
            : await locator.screenshot(screenshotOptions);
          const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
          manifest.cases.push({
            id,
            documentId: source.family,
            sourceId: source.id,
            publisher: source.publisher,
            split: source.split,
            kind,
            expectedTask: kind === 'equation' ? 'equation' : 'mixed',
            image: { file: `images/${id}.png`, sha256: sha(bytes), ...dimensions },
            reference: {
              status: 'source-checked',
              method: 'Visible DOM prose and original author TeX; independent of OCR.',
              segments: candidate.segments,
            },
            evidence: { target: candidate.target, html: candidate.html },
            tags: [kind, source.publisher],
          });
          captured++;
          chosenTargets.push(candidate.target);
        }
        if (captured !== count)
          throw new Error(`${source.id}: only ${captured}/${count} visible ${kind} targets`);
      }
      manifest.documents.push(documentRecord);
      await writeFile(`${root}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
      console.log(
        `${source.id}: ${Object.values(source.counts).reduce((a, b) => a + b, 0)} crops, ${manifest.cases.length} total`,
      );
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(
  `Captured ${manifest.cases.length} original crops. Audit and freeze before evaluation.`,
);
