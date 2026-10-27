import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { DOMParser } from 'linkedom';
import { corpusPath } from './lib/corpus-files.mjs';

try {
  await readFile(corpusPath('freeze.json'));
  throw new Error('Cannot edit frozen provenance');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const manifest = JSON.parse(await readFile(corpusPath('manifest.json'), 'utf8'));
for (const source of manifest.documents) {
  if (source.importedFrom) continue;
  source.licenseUrl = source.licenseUrl.replace(/^http:/, 'https:');
  source.modifications = [
    'Removed .reference, .mw-editsection, and mjx-labels nodes if present. Other visible citations retained. Targets cropped without scaling.',
  ];
  if (manifest.version === 2)
    source.modifications = [
      'Removed citation/edit controls, equation labels (.reference, .mw-editsection, mjx-labels, .ltx_tag_equation, .ltx_eqn_eqno, .eqno), duplicate MathJax accessibility markup, and Distill footnote/citation widgets before both reference extraction and screenshot.',
      'Excluded figure captions, notebook controls, overflowing targets, and targets clipped by scroll/hidden/clip ancestors. Captured original source rendering without scaling.',
    ];
  if (source.excludeNumberedEquations)
    source.modifications.push(
      'Excluded author TeX containing automatic equation environments or explicit tags to avoid mismatched generated equation numbers.',
    );
  if (source.adapter === 'mathjax2')
    source.modifications.push(
      'Equation screenshot bounds include visible text ranges outside the nominal MathJax inline box, preserving complete scripts without rendering replacement images.',
    );
  if (source.publisher === 'PLOS')
    source.modifications.push(
      'Full-viewport fixed consent overlays and reveal-modal elements hidden for capture.',
    );
  const html = gunzipSync(await readFile(corpusPath(source.originalSnapshot))).toString();
  const document = new DOMParser().parseFromString(html, 'text/html');
  if (source.publisher === 'PLOS') {
    source.authors = [...document.querySelectorAll('meta[name="citation_author"]')].map((m) =>
      m.getAttribute('content'),
    );
    source.copyrightNotice = [...document.querySelectorAll('p')]
      .find((p) => p.textContent.trim().startsWith('Copyright:'))
      ?.textContent.trim();
    source.articleLicenseUrl =
      [...document.querySelectorAll('a[href*="creativecommons.org/licenses/"]')].map(
        (a) => a.href,
      )[0] ?? null;
    if (!source.articleLicenseUrl)
      source.license = 'CC-BY (article notice does not specify version)';
  }
  if (source.publisher === 'Wikipedia')
    source.permalink = `https://en.wikipedia.org/w/index.php?oldid=${source.revisionId}`;
  if (source.publisher === 'ILA')
    source.sourceRevision = '224734d7be7ff0c4a8adb3a206356ea122112f33';
  if (source.adapter === 'mathml')
    source.modifications.push(
      'Native equation tables joined from original MathML alttext in row/cell order; equation numbers excluded. Unsupported non-math equation-cell content rejected.',
    );
  if (source.publisher === 'Distill') {
    const metadata = new DOMParser().parseFromString(
      gunzipSync(await readFile(corpusPath(source.snapshot))).toString(),
      'text/html',
    );
    const authors = [...metadata.querySelectorAll('meta[name="citation_author"]')].map((node) =>
      node.getAttribute('content'),
    );
    if (authors.length) source.authors = authors;
    else
      for (const script of document.querySelectorAll(
        'script[type="text/json"],script[type="application/ld+json"]',
      )) {
        try {
          const data = JSON.parse(script.textContent);
          if (data.authors?.length) {
            source.authors = data.authors
              .map((author) => author.author ?? author.name)
              .filter(Boolean);
            break;
          }
        } catch {}
      }
  }
}
for (const sample of manifest.cases) {
  if (sample.publisher === 'Wikipedia' && !sample.origin) {
    const evidence = new DOMParser().parseFromString(sample.evidence.html, 'text/html');
    const images = [...evidence.querySelectorAll('img[class*="mwe-math-fallback-image"]')];
    sample.reference.segments
      .filter((s) => s.kind === 'math')
      .forEach((span, index) => {
        span.display =
          images[index]?.classList.contains('mwe-math-fallback-image-display') ?? span.display;
      });
  }
  if (manifest.version === 2) {
    const latex = sample.reference.segments
      .filter((s) => s.kind === 'math')
      .map((s) => s.latex)
      .join(' ');
    const features = {
      bold: /\\(?:mathbf|boldsymbol|bm)\b/,
      greek:
        /\\(?:alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|sigma|phi|varphi|omega|Phi|Gamma|Sigma)\b/,
      subscripts: /_/,
      superscripts: /\^/,
      fractions: /\\(?:frac|dfrac|tfrac)\b/,
      matrices: /\\begin\{(?:[bBpPvV]?matrix|array|smallmatrix)\}/,
      multiline: /\\begin\{(?:aligned|align|split|gather|cases)\}|\\\\/,
      accents: /\\(?:hat|widehat|bar|overline|vec|dot|ddot|tilde|widetilde)\b/,
      integrals: /\\(?:int|iint|iiint|oint)\b/,
    };
    sample.tags = [
      ...new Set([
        ...sample.tags,
        ...Object.entries(features)
          .filter(([, pattern]) => pattern.test(latex))
          .map(([name]) => name),
      ]),
    ];
  }
}
await writeFile(corpusPath('manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Source attribution and display metadata checked against archived evidence.');
