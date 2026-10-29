import { expect, it } from 'vitest';
import { normalizePaddleOutput, paddleTokenCount, paddleOptionsSchema } from '../src/paddle-engine';


it('renders bare formula output while preserving existing delimiters and prose', () => {
  expect(normalizePaddleOutput(' x^2 + y^2 ', 'formula')).toBe('\\[x^2 + y^2\\]');
  for (const text of ['\\[x^2\\]', '$$x^2$$', '$x^2$', '\\(x^2\\)', '```latex\nx^2\n```'])
    expect(normalizePaddleOutput(text, 'formula')).toBe(text);
  expect(normalizePaddleOutput(' The price is $10. ', 'ocr')).toBe('The price is $10.');
  expect(normalizePaddleOutput(' ', 'formula')).toBe('');
});

it('excludes EOS from generated token counts without discarding a token at the output cap', () => {
  expect(paddleTokenCount({ text: 'x', greedy: { tokenIds: [10, 20, 2], stopReason: 'eos' } })).toBe(2);
  expect(paddleTokenCount({ text: 'x', greedy: { tokenIds: [10, 20], stopReason: 'max_steps' } })).toBe(2);
  expect(paddleTokenCount({ text: '', greedy: { tokenIds: [2], stopReason: 'eos' } })).toBe(0);
});

it('bounds configurable pixel and prompt budgets before the runtime can allocate them', () => {
  const base = { task: 'formula', maxGeneratedTokens: 2048 };
  expect(paddleOptionsSchema.parse(base)).toEqual(base);
  expect(paddleOptionsSchema.parse({ ...base, preprocessing: { minPixels: 225_792 } }).preprocessing)
    .toEqual({ minPixels: 225_792, maxPixels: 1_003_520 });
  expect(paddleOptionsSchema.safeParse({ ...base, preprocessing: { maxPixels: 8_000_000 } }).success).toBe(false);
  // a lower cap can round a valid 200:1 crop's short side down to zero patches
  expect(paddleOptionsSchema.safeParse({ ...base, preprocessing: { maxPixels: 112_896 } }).success).toBe(false);
  expect(paddleOptionsSchema.safeParse({ ...base, preprocessing: { minPixels: 300_000, maxPixels: 200_000 } }).success).toBe(false);
  expect(paddleOptionsSchema.safeParse({ ...base, promptSuffixIds: [103424] }).success).toBe(false);
  expect(paddleOptionsSchema.safeParse({ ...base, promptSuffixIds: Array(513).fill(1) }).success).toBe(false);
});
