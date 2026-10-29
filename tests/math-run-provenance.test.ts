import { expect, it } from 'vitest';
import { verifyMathRun } from '../scripts/math-benchmark/provenance';

const hash = '1'.repeat(64), other = '2'.repeat(64);
const prompts = { sha256: hash, profiles: { nativeFormula: { task: 'formula', promptSuffixIds: [1, 2] },
  nativeOCR: { task: 'ocr', promptSuffixIds: [3, 4] }, conciseFormula: { task: 'formula', promptSuffixIds: [5, 6] } } };
const baseline = () => ({ variant: 'baseline', manifestSha256: hash, finishedAt: 'now', browser: 'Chrome test',
  modelRevision: 'pinned', promptFileSha256: hash, runtimeHashes: { 'worker.js': hash }, offline: true,
  prepared: { gpu: 'test GPU' }, cases: [{ id: 'a', configuration: { profileName: 'nativeFormula',
    options: { task: 'formula', maxGeneratedTokens: 2048, promptSuffixIds: [1, 2] }, margin: 0 },
    outcome: { status: 'success', output: 'x', truncated: false } }] });
it('accepts an exactly bound native formula run', () => {
  expect(verifyMathRun(baseline(), { variant: 'baseline', manifestSha256: hash, prompts }).cases).toHaveLength(1);
});
it.each(['runtimeHashes', 'modelRevision', 'browser', 'prepared'])(
  'rejects a candidate whose %s differs from the baseline', field => {
    const before = verifyMathRun(baseline(), { variant: 'baseline', manifestSha256: hash, prompts });
    const after = { ...baseline(), [field]: field === 'runtimeHashes' ? { 'worker.js': other }
      : field === 'prepared' ? { gpu: 'another GPU' } : 'different' };
    expect(() => verifyMathRun(after, { variant: 'baseline', manifestSha256: hash, prompts, baseline: before })).toThrow();
  },
);
it('rejects incorrect variant names, prompt exports, and per-case task/configuration changes', () => {
  for (const after of [
    { ...baseline(), variant: 'ocr-only' }, { ...baseline(), promptFileSha256: other },
    { ...baseline(), cases: [{ ...baseline().cases[0], configuration: { profileName: 'nativeFormula',
      options: { task: 'ocr', maxGeneratedTokens: 2048, promptSuffixIds: [1, 2] }, margin: 0 } }] },
  ]) expect(() => verifyMathRun(after, { variant: 'baseline', manifestSha256: hash, prompts })).toThrow();
});
