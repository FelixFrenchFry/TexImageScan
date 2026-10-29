import { describe, expect, it } from 'vitest';
import { analyzeOutcome, compareRuns } from '../scripts/math-benchmark/metrics';
import type { AccuracyCase } from '../scripts/math-benchmark/dataset';

const formula = (latex: string): AccuracyCase => ({
  id: 'formula', kind: 'equation', role: 'hard', tags: [],
  image: { file: 'example.png', sha256: '0'.repeat(64) },
  reference: { status: 'approved', segments: [{ kind: 'math', latex, display: true }] },
});
const output = (text: string) => ({ status: 'success' as const, output: text, truncated: false });

describe('Paddle accuracy diagnostics', () => {
  it('keeps font differences separate from content and strict MathML', () => {
    const result = analyzeOutcome(formula('\\mathbf{x}+\\alpha'), output('x+\\alpha'));
    expect(result.strictPass).toBe(false);
    expect(result.categories).toContain('typography-difference');
    expect(result.categories).not.toContain('symbol-difference');
    expect(result.review.status).toBe('unreviewed');
  });

  it('detects a changed Greek symbol even when both formulas render', () => {
    const result = analyzeOutcome(formula('\\alpha+\\beta'), output('\\alpha+\\theta'));
    expect(result.renderable).toBe(true);
    expect(result.categories).toContain('symbol-difference');
    expect(result.spans[0]?.symbols).toMatchObject({ edits: 1, referenceCount: 3 });
  });

  it('does not mistake matching symbol order for matching script structure', () => {
    const result = analyzeOutcome(formula('x^2'), output('x_2'));
    expect(result.categories).not.toContain('symbol-difference');
    expect(result.categories).toContain('layout-difference');
    expect(result.categories).toContain('script-structure-difference');
    expect(result.strictPass).toBe(false);
  });

  it('identifies a missing matrix column and keeps truncation separate', () => {
    const result = analyzeOutcome(formula('\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}'),
      { ...output('\\begin{bmatrix}a\\\\c\\end{bmatrix}'), truncated: true });
    expect(result.categories).toContain('matrix-shape-difference');
    expect(result.categories).toContain('truncation');
    expect(result.strictPass).toBe(false);
  });

  it('excludes invisible MathML function-application markers from glyph edits', () => {
    const result = analyzeOutcome(formula('\\operatorname{E}_Y[Y]'), output('\\mathbf{E}_Y[Y]'));
    expect(result.categories).toContain('typography-difference');
    expect(result.categories).not.toContain('symbol-difference');
  });

  it('marks invalid TeX and missing mixed math boundaries for review', () => {
    const invalid = analyzeOutcome(formula('x'), output('\\frac{'));
    expect(invalid.categories).toContain('rendering-failure');
    expect(invalid.renderable).toBe(false);
    const mixed: AccuracyCase = { ...formula('x'), kind: 'mixed', reference: {
      status: 'approved', segments: [{ kind: 'text', text: 'Let ' }, { kind: 'math', latex: 'x', display: false }],
    } };
    const missing = analyzeOutcome(mixed, output('Let x'));
    expect(missing.categories).toContain('segmentation-difference');
    expect(missing.renderable).toBe(false);
  });

  it.each([
    String.raw`\[x\]\[\notacommand\]`,
    String.raw`\[x\]\[y\]\[\frac{\]`,
  ])('rejects rendering failures in additional predicted formulas: %s', (source) => {
    const result = analyzeOutcome(formula('x'), output(source));
    expect(result.renderable).toBe(false);
    expect(result.categories).toContain('rendering-failure');
    expect(result.categories).toContain('segmentation-difference');
    expect(result.strictPass).toBe(false);
  });

  it('keeps valid additional formulas renderable while reporting their span-count mismatch', () => {
    const result = analyzeOutcome(formula('x'), output(String.raw`\[x\]\[y\]`));
    expect(result.renderable).toBe(true);
    expect(result.categories).not.toContain('rendering-failure');
    expect(result.categories).toContain('segmentation-difference');
    expect(result.strictPass).toBe(false);
  });

  it('checks predicted formulas even when the reference contains only text', () => {
    const sample: AccuracyCase = { ...formula('x'), kind: 'text', reference: {
      status: 'approved', segments: [{ kind: 'text', text: 'Hello' }],
    } };
    const result = analyzeOutcome(sample, output(String.raw`Hello \(\notacommand\)`));
    expect(result.renderable).toBe(false);
    expect(result.categories).toContain('rendering-failure');
  });

  it('excludes additional invalid formulas from report renderability totals', () => {
    const result = compareRuns([formula('x')],
      [{ id: 'formula', outcome: output(String.raw`\[x\]`) }],
      [{ id: 'formula', outcome: output(String.raw`\[x\]\[\notacommand\]`) }]);
    expect(result.summary).toMatchObject({ baselineRenderable: 1, candidateRenderable: 0 });
    expect(result.reviewQueue[0]?.candidate.analysis.categories).toContain('rendering-failure');
  });

  it('reports display-to-inline changes even when formula content strictly matches', () => {
    const result = analyzeOutcome(formula('x'), output('\\(x\\)'));
    expect(result.strictPass).toBe(true);
    expect(result.categories).toContain('layout-difference');
    expect(result.spans[0]?.displayMode).toEqual({ reference: true, output: false });
  });

  it('joins runs by case ID and reports a control regression', () => {
    const cases = [{ ...formula('x'), role: 'control' as const }];
    const result = compareRuns(cases, [{ id: 'formula', outcome: output('x') }], [
      { id: 'formula', outcome: output('y') },
    ]);
    expect(result.summary).toMatchObject({ baselineStrictPass: 1, candidateStrictPass: 0, controlRegressions: 1 });
    expect(result.reviewQueue.map((entry) => entry.id)).toEqual(['formula']);
    expect(() => compareRuns(cases, [], [])).toThrow(/Missing baseline/);
  });
});
