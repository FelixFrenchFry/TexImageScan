import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, readAccuracyManifest } from './dataset.ts';
import { analyzeOutcome, type AccuracyOutcome } from './metrics.ts';
import { writeAccuracyReport } from './report.ts';
import { readMathManifest, retrySummary } from './manifest.ts';
import { readMathPrompts, verifyMathRun, type MathRun } from './provenance.ts';

const [manifestPath, directory, variantList = 'baseline,ocr-only,concise'] = process.argv.slice(2);
assert.ok(manifestPath && directory, 'Usage: node scripts/math-benchmark/summarize.ts MANIFEST RUN_DIRECTORY [VARIANTS]');
const { manifest, manifestSha256 } = await readAccuracyManifest(manifestPath);
const { manifest: math, manifestSha256: mathManifestSha256 } = await readMathManifest();
assert.equal(manifest.provenance.mathManifestSha256, mathManifestSha256, 'Math corpus changed after split export');
const samples = new Map(manifest.cases.map(sample => [sample.id, sample]));
const quantile = (values: number[], fraction: number) => values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;
const prompts = await readMathPrompts();
let baselineRun: MathRun | undefined;
type Row = { id: string; outcome: AccuracyOutcome; analysis: ReturnType<typeof analyzeOutcome> };
const results = new Map<string, Row[]>();
const summaries: Record<string, unknown> = {};
const hashes: Record<string, string> = {};
for (const variant of variantList.split(',')) {
  const path = join(directory, `${variant}.json`), bytes = await readFile(path);
  const run = verifyMathRun(JSON.parse(bytes.toString()), { variant, manifestSha256, prompts, baseline: baselineRun });
  if (variant === 'baseline') baselineRun = run;
  else assert.ok(baselineRun, 'Compare baseline before candidates');
  assert.equal(run.manifestSha256, manifestSha256);
  assert.equal(run.cases.length, samples.size, 'Incomplete run');
  assert.equal(new Set(run.cases.map(row => row.id)).size, samples.size, 'Duplicate run IDs');
  const rows = run.cases.map(row => {
    const sample = samples.get(row.id); assert.ok(sample, `Unknown case ${row.id}`);
    return { ...row, analysis: analyzeOutcome(sample, row.outcome) };
  });
  results.set(variant, rows); hashes[variant] = sha256(bytes);
  const numbers = (field: string) => rows.flatMap(row => row.outcome.status === 'success' && typeof row.outcome[field] === 'number' ? [row.outcome[field]] : []);
  const categories: Record<string, number> = {};
  for (const row of rows) for (const category of row.analysis.categories) categories[category] = (categories[category] ?? 0) + 1;
  summaries[variant] = { cases: rows.length, strictStructurePasses: rows.filter(row => row.analysis.strictPass).length,
    renderable: rows.filter(row => row.analysis.renderable).length, diagnosticCategories: categories,
    medianMs: quantile(numbers('elapsedMs'), 0.5), p95Ms: quantile(numbers('elapsedMs'), 0.95),
    maxDecoderResidentWeightBytes: Math.max(0, ...numbers('decoderResidentWeightBytes')),
    gpuPeakMemoryBytes: null, gpuMemoryNote: 'Resident decoder weights exclude vision weights, activations and runtime allocations; no full browser GPU peak measurement is available.',
    reviewedCases: 0 };
}
const baseline = results.get('baseline'); assert.ok(baseline, 'Baseline is required');
const retries: Record<string, unknown> = {};
for (const [variant, rows] of results) {
  if (variant === 'baseline') continue;
  const after = new Map(rows.map(row => [row.id, row]));
  retries[variant] = retrySummary(baseline.map(before => {
    const candidate = after.get(before.id); assert.ok(candidate);
    return { id: before.id, before: { strictPass: before.analysis.strictPass, output: before.outcome.status === 'success' ? before.outcome.output : '' },
      after: { strictPass: candidate.analysis.strictPass, output: candidate.outcome.status === 'success' ? candidate.outcome.output : '' } };
  }));
  await writeAccuracyReport(manifestPath, join(directory, 'baseline.json'), join(directory, `${variant}.json`), join(directory, `${variant}-audit`));
}
if (results.size === 1)
  await writeAccuracyReport(manifestPath, join(directory, 'baseline.json'), join(directory, 'baseline.json'), join(directory, 'baseline-audit'));
const zoomGroups = new Map<string, typeof math.cases>();
for (const sample of math.cases.filter(sample => sample.tags.includes('source-zoom') && samples.has(sample.id))) {
  const group = zoomGroups.get(sample.familyId) ?? []; group.push(sample); zoomGroups.set(sample.familyId, group);
}
const indexed = new Map(baseline.map(row => [row.id, row]));
const zoomPairs = [...zoomGroups.values()].map(group => {
  const low = group.find(row => row.acquisition.scale === 1), high = group.find(row => row.acquisition.scale === 2);
  assert.ok(low && high, 'Incomplete source-zoom pair');
  const before = indexed.get(low.id), after = indexed.get(high.id); assert.ok(before && after);
  return { id: low.familyId, before: { strictPass: before.analysis.strictPass, output: before.outcome.status === 'success' ? before.outcome.output : '' },
    after: { strictPass: after.analysis.strictPass, output: after.outcome.status === 'success' ? after.outcome.output : '' } };
});
const summary = { manifestSha256, runSha256: hashes, variants: summaries, retries,
  sourceZoom: { ...retrySummary(zoomPairs), scope: 'Same browser-rendered source formula at CSS zoom 1 and 2, not a resized PNG or PDF zoom test.' },
  limitations: ['Strict structure, glyph and layout comparisons are diagnostics, not semantic accuracy or official CDM.',
    'Retry either-pass counts require the reference answer and cannot be used as an automatic selection policy.',
    'Visual adjudication remains separate; the generated HTML audits retain inputs, references, predictions and review queues.'] };
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
