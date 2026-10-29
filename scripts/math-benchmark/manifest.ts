import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sha256, type AccuracyManifest } from './dataset.ts';

export const mathCaseSchema = z.object({
  id: z.string().min(1), split: z.enum(['development', 'heldout']), documentId: z.string().min(1),
  familyId: z.string().min(1), tags: z.array(z.string()),
  image: z.object({ file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive(), height: z.number().int().positive() }),
  reference: z.object({ status: z.enum(['source-checked', 'approved']), segments: z.tuple([z.object({
    kind: z.literal('math'), latex: z.string().min(1), display: z.boolean(),
  })]) }),
  source: z.object({ url: z.url(), license: z.string().min(1), previouslyEvaluated: z.boolean(),
    snapshotSha256: z.string().optional(), revisionUrl: z.string().optional() }),
  acquisition: z.object({ kind: z.enum(['publisher', 'synthetic']), scale: z.number().positive() }),
});
export type MathCase = z.infer<typeof mathCaseSchema>;
export const mathManifestSchema = z.object({ version: z.literal(1), purpose: z.literal('printed-math'),
  limitations: z.array(z.string()), cases: z.array(mathCaseSchema).min(1) });

/** group formulas by normalized source text */
export function formulaFamily(latex: string) {
  return sha256(latex.replace(/\\(?:displaystyle|left|right)\b/gu, '').replace(/\s+/gu, ''));
}

export function validateMathCases(value: unknown): MathCase[] {
  const cases = z.array(mathCaseSchema).min(1).parse(value);
  const ids = new Set<string>();
  const groups = { document: new Map<string, string>(), family: new Map<string, string>(), image: new Map<string, string>() };
  for (const sample of cases) {
    assert.ok(!ids.has(sample.id), `Duplicate case ${sample.id}`); ids.add(sample.id);
    assert.equal(sample.familyId, formulaFamily(sample.reference.segments[0].latex), `Changed formula family: ${sample.id}`);
    if (sample.split === 'heldout') assert.ok(!sample.source.previouslyEvaluated, `Heldout was previously evaluated: ${sample.id}`);
    for (const [kind, key] of [['document', sample.documentId], ['family', sample.familyId], ['image', sample.image.sha256]] as const) {
      assert.ok(!groups[kind].has(key) || groups[kind].get(key) === sample.split, `Split leakage through ${kind}: ${sample.id}`);
      groups[kind].set(key, sample.split);
    }
  }
  return cases;
}

export async function readMathManifest(path = 'tests/math-benchmark/manifest.json') {
  const bytes = await readFile(path);
  const manifest = mathManifestSchema.parse(JSON.parse(bytes.toString()));
  validateMathCases(manifest.cases);
  for (const sample of manifest.cases) {
    const image = await readFile(sample.image.file);
    assert.equal(sha256(image), sample.image.sha256, `Changed image: ${sample.id}`);
    assert.equal(image.readUInt32BE(16), sample.image.width, `Wrong image width: ${sample.id}`);
    assert.equal(image.readUInt32BE(20), sample.image.height, `Wrong image height: ${sample.id}`);
  }
  return { manifest, manifestSha256: sha256(bytes) };
}

export function retrySummary(rows: { id: string; before: { output: string; strictPass: boolean }; after: { output: string; strictPass: boolean } }[]) {
  return { cases: rows.length,
    disagreements: rows.filter(row => row.before.output !== row.after.output).length,
    strictRepairs: rows.filter(row => !row.before.strictPass && row.after.strictPass).length,
    strictRegressions: rows.filter(row => row.before.strictPass && !row.after.strictPass).length,
    strictEitherPass: rows.filter(row => row.before.strictPass || row.after.strictPass).length,
    selectionPolicy: 'none; reference-dependent upper bound, not an automatic retry accuracy' };
}

export async function exportSplit(split: 'development' | 'heldout', output: string) {
  const { manifest, manifestSha256 } = await readMathManifest();
  const cases = manifest.cases.filter(sample => sample.split === split);
  assert.ok(cases.length, `Empty ${split} split`);
  const exported: AccuracyManifest = { version: 1, purpose: split === 'heldout' ? 'math-heldout' : 'math-development',
    provenance: { mathManifestSha256: manifestSha256, split, limitations: manifest.limitations },
    cases: cases.map(sample => ({ id: sample.id, kind: 'equation', role: split === 'heldout' ? 'fresh' : 'benchmark', tags: sample.tags,
      image: sample.image, reference: sample.reference })) };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(exported, null, 2) + '\n', { flag: 'wx' });
  return { cases: cases.length, manifestSha256: sha256(JSON.stringify(exported, null, 2) + '\n') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, split, output] = process.argv.slice(2);
  if (command === 'verify') {
    const { manifest, manifestSha256 } = await readMathManifest();
    console.log(JSON.stringify({ cases: manifest.cases.length, manifestSha256,
      splits: Object.fromEntries(['development', 'heldout'].map(split => [split, manifest.cases.filter(row => row.split === split).length])) }));
  } else if (command === 'export' && (split === 'development' || split === 'heldout') && output)
    console.log(JSON.stringify(await exportSplit(split, output)));
  else throw new Error('Usage: node scripts/math-benchmark/manifest.ts verify | export development|heldout OUTPUT');
}
