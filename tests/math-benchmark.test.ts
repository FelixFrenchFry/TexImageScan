import { expect, it } from 'vitest';
import { validateMathCases, formulaFamily, retrySummary, readMathManifest } from '../scripts/math-benchmark/manifest';

const sample = (id: string, split: 'development' | 'heldout', documentId: string, latex: string) => ({
  id, split, documentId, familyId: formulaFamily(latex), tags: ['indices'],
  image: { file: `${id}.png`, sha256: id.padEnd(64, '0'), width: 100, height: 50 },
  reference: { status: 'source-checked' as const, segments: [{ kind: 'math' as const, latex, display: true }] },
  source: { url: 'https://example.org/math', license: 'CC-BY-SA-4.0', previouslyEvaluated: false },
  acquisition: { kind: 'publisher' as const, scale: 1 },
});
it('keeps a source document out of both tuning and heldout', () => {
  expect(() => validateMathCases([sample('a', 'development', 'same', 'x'), sample('b', 'heldout', 'same', 'y')])).toThrow(/document/);
});
it('keeps equivalent source families and identical image bytes out of different splits', () => {
  expect(formulaFamily('\\displaystyle x + y')).toBe(formulaFamily('x+y'));
  expect(() => validateMathCases([sample('a', 'development', 'one', 'x+y'), sample('b', 'heldout', 'two', 'x + y')])).toThrow(/family/);
  const a = sample('a', 'development', 'one', 'x');
  expect(() => validateMathCases([a, { ...sample('b', 'heldout', 'two', 'y'), image: a.image }])).toThrow(/image/);
});
it('rejects previously evaluated heldout sources and prose references', () => {
  const a = sample('a', 'heldout', 'one', 'x');
  expect(() => validateMathCases([{ ...a, source: { ...a.source, previouslyEvaluated: true } }])).toThrow(/previously/);
  expect(() => validateMathCases([{ ...a, reference: { ...a.reference, segments: [{ kind: 'text', text: 'Hello' }] } }])).toThrow();
});
it('reports retry opportunities and disagreements without selecting an answer', () => {
  const rows = [{ id: 'a', before: { output: 'x^2', strictPass: false }, after: { output: 'x_2', strictPass: true } },
    { id: 'b', before: { output: 'y', strictPass: true }, after: { output: 'z', strictPass: false } }];
  expect(retrySummary(rows)).toEqual({ cases: 2, disagreements: 2, strictRepairs: 1, strictRegressions: 1, strictEitherPass: 2,
    selectionPolicy: 'none; reference-dependent upper bound, not an automatic retry accuracy' });
});
it('verifies the published math corpus and its source images', async () => {
  const { manifest } = await readMathManifest();
  expect(manifest.cases.filter(row => row.split === 'heldout')).toHaveLength(32);
  expect(manifest.cases.filter(row => row.tags.includes('source-zoom'))).toHaveLength(16);
});
