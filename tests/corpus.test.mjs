import { describe, expect, it } from 'vitest';
import { compareMath, scoreCase, summarize, validateManifest } from '../scripts/lib/corpus.mjs';

const sample = (kind, segments) => ({
  id: 'one',
  documentId: 'book',
  split: 'development',
  kind,
  expectedTask: kind === 'equation' ? 'equation' : 'mixed',
  reference: { status: 'source-checked', segments },
});
const prose = sample('text', [{ kind: 'text', text: 'Read every word in order.' }]);
const success = (output, extra = {}) => ({
  status: 'success',
  output,
  task: 'mixed',
  truncated: false,
  ...extra,
});

describe('independent OCR scoring', () => {
  it('keeps spaces significant but accepts line wrapping and NBSP', () => {
    expect(scoreCase(prose, success('Read every\nword in\u00a0order.')).pass).toBe(true);
    const score = scoreCase(prose, success('Readeverywordinorder.'));
    expect(score.pass).toBe(false);
    expect(score.prose.cer).toBeGreaterThan(0);
    expect(score.prose.wer).toBeGreaterThan(0);
    expect(score.prose.compactExact).toBe(true);
  });
  it('accepts presentation differences and preserves mathematical distinctions', () => {
    for (const [a, b] of [
      ['x_i', 'x_{i}'],
      ['\\left(x\\right)', '(x)'],
      ['\\frac12', '\\frac{1}{2}'],
    ]) {
      expect(compareMath(a, b).structuralMatch).toBe(true);
    }
    expect(
      compareMath(
        '\\begin{align}a&=b\\\\c&=d\\end{align}',
        '\\begin{aligned}a&=b\\\\c&=d\\end{aligned}',
        true,
      ).structuralMatch,
    ).toBe(true);
    expect(compareMath('a+b', '{\\displaystyle a+b}').structuralMatch).toBe(true);
    expect(compareMath('a+b', '{\\textstyle a+b}').structuralMatch).toBe(true);
    expect(compareMath('\\sum_i x_i', '\\displaystyle\\sum_i x_i').structuralMatch).toBe(true);
    for (const [a, b] of [
      ['\\boldsymbol{x}_i', 'x_i'],
      ['x_{ij}', 'x_i j'],
      ['a-b', 'a+b'],
      ['a\\le b', 'a<b'],
      ['\\boldsymbol{x}', '\\mathbf{x}'],
      ['\\epsilon', '\\varepsilon'],
      ['\\frac{a}{b}', '\\genfrac{}{}{0pt}{}{a}{b}'],
      ['\\text{a b}', '\\text{ab}'],
      ['a+b', 'b+a'],
      ['\\frac{ab}{cd}', '\\frac{a}{bcd}'],
      ['\\begin{matrix}a&b\\\\c&d\\end{matrix}', '\\begin{matrix}a&c\\\\b&d\\end{matrix}'],
    ]) {
      expect(compareMath(a, b).structuralMatch).toBe(false);
    }
  });
  it('scores mixed text and ordered math separately without repairing it', () => {
    const mixed = sample('mixed', [
      { kind: 'text', text: 'Use ' },
      { kind: 'math', latex: 'x_i', display: false },
      { kind: 'text', text: ' and ' },
      { kind: 'math', latex: 'y', display: false },
      { kind: 'text', text: '.' },
    ]);
    expect(scoreCase(mixed, success('Use $x_{i}$ and \\(y\\).')).pass).toBe(true);
    expect(scoreCase(mixed, success('Use $y$ and $x_i$.')).pass).toBe(false);
    expect(scoreCase(mixed, success('Use $x_i$ and y.')).flags).toContain('math-span-count');
    expect(scoreCase(mixed, success('Use $x_i and $y$.')).flags).toContain('unmatched-delimiter');
  });
  it('handles bare equations, fences, escaped currency, and unsupported references', () => {
    const eq = sample('equation', [{ kind: 'math', latex: 'x_i', display: true }]);
    expect(scoreCase(eq, success('```latex\n$$x_{i}$$\n```')).pass).toBe(true);
    expect(scoreCase(eq, success('x_i')).pass).toBe(true);
    expect(scoreCase(eq, success('Here it is: $x_i$')).pass).toBe(false);
    expect(
      scoreCase(sample('text', [{ kind: 'text', text: 'Costs $5.' }]), success('Costs \\$5.')).pass,
    ).toBe(true);
    expect(compareMath('\\unknown{x}', 'x').referenceRenderable).toBe(false);
  });
  it('never credits missing references, failures, truncation, or empty outputs', () => {
    expect(
      scoreCase(
        { ...prose, reference: { status: 'pending-review', segments: [] } },
        success('anything'),
      ).scored,
    ).toBe(false);
    expect(
      scoreCase(prose, { status: 'error', message: 'failed', output: 'Read every word in order.' })
        .scored,
    ).toBe(false);
    expect(scoreCase(prose, success('Read every word in order.', { truncated: true })).pass).toBe(
      false,
    );
    expect(scoreCase(prose, success('')).pass).toBe(false);
    expect(
      scoreCase({ ...prose, reference: { status: 'source-checked', segments: [] } }, success(''))
        .scored,
    ).toBe(false);
  });
  it('reports partial execution with explicit denominators', () => {
    const entries = [success('wrong'), { status: 'error' }, { status: 'not-run' }].map(
      (outcome, i) => ({ sample: { ...prose, id: String(i) }, outcome }),
    );
    const report = summarize(entries);
    expect(report.counts).toMatchObject({
      selected: 3,
      attempted: 2,
      success: 1,
      error: 1,
      notRun: 1,
      scored: 1,
      passed: 0,
    });
    expect(report.complete).toBe(false);
    expect(() => summarize([])).toThrow(/empty/i);
  });
  it('rejects duplicate cases and splits from the same document', () => {
    expect(() => validateManifest({ cases: [prose, prose] })).toThrow(/duplicate/i);
    expect(() =>
      validateManifest({ cases: [prose, { ...prose, id: 'two', split: 'heldout' }] }),
    ).toThrow(/split/i);
    expect(() =>
      validateManifest({
        cases: [
          {
            ...prose,
            sourceId: 'source',
            evidence: { target: 'p', html: '<p><img data-corpus-target="eq"></p>' },
          },
          {
            ...prose,
            id: 'two',
            sourceId: 'source',
            evidence: { target: 'eq', html: '<img data-corpus-target="eq">' },
          },
        ],
      }),
    ).toThrow(/nested/i);
  });
});
