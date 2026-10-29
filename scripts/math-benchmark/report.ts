import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import katex from 'katex';
import { z } from 'zod';
import { comparisonSource } from '../lib/corpus.mjs';
import { readAccuracyManifest, sha256, type AccuracyManifest, type ReferenceSegment } from './dataset.ts';
import { compareRuns, outputSegments, runEntrySchema } from './metrics.ts';
import { readMathPrompts, verifyMathRun } from './provenance.ts';

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function renderSegments(segments: ReferenceSegment[]) {
  return segments.map((segment) => {
    if (segment.kind === 'text') return escape(segment.text);
    try {
      return katex.renderToString(comparisonSource(segment.latex), { displayMode: segment.display,
        throwOnError: true, strict: 'ignore', trust: false });
    } catch (error) { return `<span class="error">${escape(String(error))}</span>`; }
  }).join('');
}

export function auditHtml({ manifest, comparison, css, images, identity }: {
  manifest: AccuracyManifest; comparison: ReturnType<typeof compareRuns>; css: string;
  images: Map<string, string>; identity: string;
}) {
  const samples = new Map(manifest.cases.map((sample) => [sample.id, sample]));
  const rows = comparison.cases.map((entry) => {
    const sample = samples.get(entry.id);
    assert.ok(sample);
    const outcomeCell = (value: typeof entry.baseline, label: string) => {
      const raw = value.outcome.status === 'success'
        ? typeof value.outcome.rawText === 'string' ? value.outcome.rawText : value.outcome.output
        : JSON.stringify(value.outcome);
      const rendered = value.outcome.status === 'success' ? renderSegments(outputSegments(sample, value.outcome.output)) : '<p>Inference failed.</p>';
      return `<div class="output"><h3>${label}</h3><p>Strict MathML ${value.analysis.strictPass ? 'pass' : 'fail'}; ${value.analysis.renderable ? 'renderable' : 'not renderable'}</p>
        <p class="categories">${escape(value.analysis.categories.join(', ') || 'No diagnostic differences')}</p><div class="render">${rendered}</div><details><summary>Raw output and diagnostics</summary><pre>${escape(raw)}</pre><pre>${escape(JSON.stringify(value.analysis.spans, null, 2))}</pre></details></div>`;
    };
    return `<article id="${escape(entry.id)}" data-id="${escape(entry.id)}"><h2>${escape(entry.id)}</h2>
      <p>${escape(entry.role)} | ${escape(entry.kind)} | ${escape(entry.tags.join(', '))}</p>
      <div class="input"><h3>Input image</h3><img src="${escape(images.get(entry.id) ?? '')}" alt="Input for ${escape(entry.id)}"></div>
      <div class="columns"><div class="output"><h3>Reference</h3><div class="render">${renderSegments(sample.reference.segments)}</div><details><summary>Reference source</summary><pre>${escape(JSON.stringify(sample.reference.segments, null, 2))}</pre></details></div>
      ${outcomeCell(entry.baseline, 'Baseline')}${outcomeCell(entry.candidate, 'Candidate')}</div>
      <div class="review"><label>Visual/content review <select data-field="verdict"><option value="unreviewed">Unreviewed</option><option value="equivalent">Both equivalent to input</option><option value="candidate-better">Candidate has fewer recognition errors</option><option value="baseline-better">Baseline has fewer recognition errors</option><option value="both-wrong">Both contain recognition errors</option><option value="reference-issue">Reference issue</option><option value="uncertain">Uncertain</option></select></label>
      <label>Observed symbols, omissions, typography, layout or boundaries <textarea data-field="notes" rows="2"></textarea></label></div></article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Paddle accuracy audit</title><style>${css}
  body{font:16px system-ui,sans-serif;margin:24px;background:#f5f5f5;color:#151515}h1,h2,h3{font-weight:600}.summary,article{background:white;padding:20px;margin-bottom:24px;border:1px solid #ccc;border-radius:8px}
  article h2{overflow-wrap:anywhere}.columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.output{overflow:auto;border:1px solid #ddd;padding:12px}.render{min-height:80px;overflow:auto;font:19px Georgia,serif;line-height:1.6;white-space:pre-wrap}.input img{max-width:100%;max-height:650px;object-fit:contain;object-position:left}.categories{font-size:13px;color:#555}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.error{color:#a20}.review{display:grid;gap:12px;margin-top:16px}label{display:grid;gap:6px}select,textarea,button{font:inherit;padding:8px}.katex-display{overflow:auto}.notice{color:#852500}@media(max-width:1000px){.columns{grid-template-columns:1fr}}
  </style><main><h1>Paddle accuracy audit</h1><div class="summary"><p class="notice">No human equivalence decisions have been made. MathML, glyph, font and layout differences are review aids. They are not CDM or proof of mathematical equivalence.</p>
  <p>${escape(manifest.purpose)} | ${escape(comparison.metric)}</p><pre>${escape(JSON.stringify(comparison.summary, null, 2))}</pre><p>Review decisions are saved in this browser. Export them to preserve the audit.</p><button id="export">Export review JSON</button><span id="saved"></span></div>${rows}</main>
  <script>
  const identity=${JSON.stringify(identity).replaceAll('<', '\\u003c')};
  const storageKey='paddle-accuracy-review:'+identity;
  let reviews={};try{reviews=JSON.parse(localStorage.getItem(storageKey)||'{}')}catch{}
  for(const article of document.querySelectorAll('article')){const id=article.dataset.id;const value=reviews[id]||{};for(const control of article.querySelectorAll('[data-field]')){control.value=value[control.dataset.field]||(control.dataset.field==='verdict'?'unreviewed':'');control.addEventListener('input',()=>{reviews[id]=Object.fromEntries([...article.querySelectorAll('[data-field]')].map(control=>[control.dataset.field,control.value]));localStorage.setItem(storageKey,JSON.stringify(reviews));document.querySelector('#saved').textContent=' Saved locally';})}}
  document.querySelector('#export').onclick=()=>{const data={version:1,identity,exportedAt:new Date().toISOString(),reviews};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='paddle-accuracy-review.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
  </script></html>`;
}

export function parseRunEntries(value: unknown, expectedManifestSha256?: string) {
  const binding = z.object({ cases: z.array(z.unknown()), manifestSha256: z.string().optional() }).safeParse(value);
  if (expectedManifestSha256 && binding.success && binding.data.manifestSha256)
    assert.equal(binding.data.manifestSha256, expectedManifestSha256, 'Run belongs to a different manifest');
  return z.union([z.object({ cases: z.array(runEntrySchema) }),
    z.object({ summary: z.object({ cases: z.array(runEntrySchema) }) })]).transform((report) => 'cases' in report ? report.cases : report.summary.cases).parse(value);
}

export async function writeAccuracyReport(manifestPath: string, baselinePath: string, candidatePath: string, prefix: string) {
  const { manifest, manifestSha256 } = await readAccuracyManifest(manifestPath);
  const [baselineBytes, candidateBytes] = await Promise.all([readFile(baselinePath), readFile(candidatePath)]);
  if (manifest.purpose === 'math-development' || manifest.purpose === 'math-heldout') {
    const prompts = await readMathPrompts();
    const before = verifyMathRun(JSON.parse(baselineBytes.toString()), { variant: 'baseline', manifestSha256, prompts });
    const candidate = z.object({ variant: z.string() }).parse(JSON.parse(candidateBytes.toString()));
    verifyMathRun(JSON.parse(candidateBytes.toString()), { variant: candidate.variant, manifestSha256, prompts, baseline: before });
  }
  const baseline = parseRunEntries(JSON.parse(baselineBytes.toString()), manifestSha256),
    candidate = parseRunEntries(JSON.parse(candidateBytes.toString()), manifestSha256);
  const comparison = compareRuns(manifest.cases, baseline, candidate);
  const sourceHashes = { manifest: manifestSha256, baseline: sha256(baselineBytes), candidate: sha256(candidateBytes),
    metrics: sha256(await readFile('scripts/math-benchmark/metrics.ts')), scorer: sha256(await readFile('scripts/lib/corpus.mjs')) };
  const identity = sha256(JSON.stringify(sourceHashes));
  let css = await readFile('node_modules/katex/dist/katex.min.css', 'utf8');
  for (const match of [...css.matchAll(/url\((fonts\/[^)]+)\)/g)]) {
    const file = match[1];
    assert.ok(file);
    const data = await readFile(resolve('node_modules/katex/dist', file));
    css = css.replaceAll(`url(${file})`, `url(data:font/woff2;base64,${data.toString('base64')})`);
  }
  const images = new Map(await Promise.all(manifest.cases.map(async (sample): Promise<[string, string]> =>
    [sample.id, `data:image/png;base64,${(await readFile(sample.image.file)).toString('base64')}`])));
  await mkdir(dirname(prefix), { recursive: true });
  await writeFile(`${prefix}.json`, JSON.stringify({ version: 1, sourceHashes, inputs: { manifestPath, baselinePath, candidatePath }, ...comparison }, null, 2) + '\n');
  await writeFile(`${prefix}.html`, auditHtml({ manifest, comparison, css, images, identity }));
  await writeFile(`${prefix}-review-queue.json`, JSON.stringify({ version: 1, identity, sourceHashes,
    instructions: 'Inspect input, reference and both rendered outputs. Record observed differences; do not infer semantic correctness from glyph order alone.',
    cases: comparison.reviewQueue.map((entry) => ({ id: entry.id, role: entry.role,
      baselineCategories: entry.baseline.analysis.categories, candidateCategories: entry.candidate.analysis.categories,
      verdict: 'unreviewed', notes: '' })) }, null, 2) + '\n');
  return comparison.summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifest, baseline, candidate, prefix] = process.argv.slice(2);
  assert.ok(manifest && baseline && candidate && prefix, 'Usage: node scripts/math-benchmark/report.ts MANIFEST BASELINE CANDIDATE OUTPUT_PREFIX');
  console.log(JSON.stringify(await writeAccuracyReport(manifest, baseline, candidate, prefix)));
}
