import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

export const segmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1) }),
  z.object({ kind: z.literal('math'), latex: z.string().min(1), display: z.boolean() }),
]);
export type ReferenceSegment = z.infer<typeof segmentSchema>;
export const accuracyCaseSchema = z.object({
  id: z.string().min(1), kind: z.enum(['equation', 'mixed', 'text']),
  role: z.enum(['hard', 'control', 'fresh', 'benchmark']), tags: z.array(z.string()),
  image: z.object({ file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }),
  reference: z.object({ status: z.enum(['source-checked', 'approved']), segments: z.array(segmentSchema).min(1) }),
  source: z.object({ caseId: z.string(), split: z.literal('development'), documentId: z.string().optional(), publisher: z.string().optional() }).optional(),
});
export type AccuracyCase = z.infer<typeof accuracyCaseSchema>;
export const accuracyManifestSchema = z.object({
  version: z.literal(1), purpose: z.enum(['development', 'native-parity', 'fresh-validation', 'math-development', 'math-heldout']),
  provenance: z.record(z.string(), z.unknown()), cases: z.array(accuracyCaseSchema).min(1),
});
export type AccuracyManifest = z.infer<typeof accuracyManifestSchema>;
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function readAccuracyManifest(path: string, imageRoot = process.cwd()) {
  const bytes = await readFile(path);
  const manifest = accuracyManifestSchema.parse(JSON.parse(bytes.toString()));
  if (manifest.purpose === 'fresh-validation') {
    const freeze = z.object({ manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(
      JSON.parse(await readFile(path.replace(/\.json$/u, '-freeze.json'), 'utf8')));
    assert.equal(sha256(bytes), freeze.manifestSha256, 'Frozen manifest changed');
  }
  const ids = new Set<string>();
  for (const sample of manifest.cases) {
    assert.ok(!ids.has(sample.id), `Duplicate case: ${sample.id}`);
    ids.add(sample.id);
    assert.equal(sha256(await readFile(resolve(imageRoot, sample.image.file))), sample.image.sha256, `Changed image: ${sample.id}`);
    if (manifest.purpose === 'fresh-validation') assert.equal(sample.role, 'fresh');
  }
  return { manifest, manifestSha256: sha256(bytes) };
}
