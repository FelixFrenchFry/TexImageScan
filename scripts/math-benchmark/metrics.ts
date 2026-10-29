import assert from 'node:assert/strict';
import katex from 'katex';
import { DOMParser } from 'linkedom';
import { z } from 'zod';
import { splitMath } from '../../src/preview.ts';
import { comparisonSource, scoreCase } from '../lib/corpus.mjs';
import type { AccuracyCase, ReferenceSegment } from './dataset.ts';

export const outcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success'), output: z.string(), truncated: z.boolean().default(false),
    elapsedMs: z.number().optional(), wallMs: z.number().optional(), tokenCount: z.number().optional() }).passthrough(),
  z.object({ status: z.enum(['error', 'timeout', 'not-run']), error: z.string().optional() }).passthrough(),
]);
export type AccuracyOutcome = z.infer<typeof outcomeSchema>;
export const runEntrySchema = z.object({ id: z.string(), outcome: outcomeSchema });
export type RunEntry = z.infer<typeof runEntrySchema>;
export const categories = ['inference-failure', 'rendering-failure', 'segmentation-difference', 'prose-difference',
  'symbol-difference', 'typography-difference', 'layout-difference', 'strict-only-difference',
  'matrix-shape-difference', 'script-structure-difference', 'truncation'] as const;
export type DifferenceCategory = typeof categories[number];
const scoreSchema = z.object({ scored: z.boolean(), pass: z.boolean(), flags: z.array(z.string()),
  prose: z.object({ exact: z.boolean(), charEdits: z.number(), characters: z.number() }).nullable().optional(),
  math: z.array(z.object({ structuralMatch: z.boolean(), referenceRenderable: z.boolean(), outputRenderable: z.boolean() })).optional(),
});

export function outputSegments(sample: Pick<AccuracyCase, 'kind'>, output: string): ReferenceSegment[] {
  const parts = splitMath(output.trim());
  if (sample.kind === 'equation' && !parts.some((part) => part.kind === 'math'))
    return [{ kind: 'math', latex: output.trim(), display: true }];
  return parts.map((part) => part.kind === 'math'
    ? { kind: 'math', latex: part.source, display: part.display }
    : { kind: 'text', text: part.source });
}

function editDistance(a: string[], b: string[]) {
  let previous = b.map((_, index) => index + 1);
  previous.unshift(0);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min((next[j] ?? 0) + 1,
      (previous[j + 1] ?? 0) + 1, (previous[j] ?? 0) + Number(a[i] !== b[j])));
    previous = next;
  }
  return previous[b.length] ?? 0;
}

function presentation(latex: string, display: boolean) {
  try {
    const html = katex.renderToString(comparisonSource(latex), { output: 'mathml', displayMode: display,
      throwOnError: true, strict: 'ignore', trust: false });
    const document = new DOMParser().parseFromString(html, 'text/html');
    const symbols: string[] = [], typography: string[] = [], scripts: string[] = [];
    function structure(node: Element): unknown[] {
      const tag = node.localName;
      if (['annotation', 'mspace'].includes(tag)) return [];
      if (['msub', 'msup', 'msubsup', 'mmultiscripts', 'munder', 'mover', 'munderover'].includes(tag))
        scripts.push(`${symbols.length}:${tag}`);
      const font = node.getAttribute('mathvariant');
      if (font) typography.push(`${symbols.length}:${font}`);
      if (['mi', 'mn', 'mo', 'mtext'].includes(tag)) {
        // exclude invisible MathML operators from visible glyph comparisons
        const content = [...node.textContent.normalize('NFC')].filter((char) => !/[\s\p{Cf}]/u.test(char));
        symbols.push(...content);
        return content.map(() => 'glyph');
      }
      const children = [...node.children].flatMap(structure);
      if (['math', 'semantics', 'mrow', 'mstyle'].includes(tag)) return children;
      return [[tag, children]];
    }
    const math = document.querySelector('math');
    assert.ok(math, 'Missing rendered MathML');
    const layout = JSON.stringify(structure(math));
    const matrices = [...math.querySelectorAll('mtable')].map(table => [...table.children]
      .filter(row => ['mtr', 'mlabeledtr'].includes(row.localName))
      .map(row => [...row.children].filter(cell => cell.localName === 'mtd')
        .reduce((sum, cell) => sum + Number(cell.getAttribute('columnspan') ?? 1), 0)));
    return { kind: 'rendered' as const, symbols, typography, layout, matrices, scripts };
  } catch (error) {
    return { kind: 'error' as const, error: error instanceof Error ? error.message : String(error) };
  }
}

/** matching glyphs alone cannot establish mathematical equivalence */
export function analyzeOutcome(sample: AccuracyCase, outcome: AccuracyOutcome) {
  const strict = scoreSchema.parse(scoreCase(sample, outcome));
  const found = new Set<DifferenceCategory>();
  if (outcome.status !== 'success') found.add('inference-failure');
  if (outcome.status === 'success' && outcome.truncated) found.add('truncation');
  const segments = outcome.status === 'success' ? outputSegments(sample, outcome.output) : [];
  const expectedMath = sample.reference.segments.filter((segment) => segment.kind === 'math');
  const actualMath = segments.filter((segment) => segment.kind === 'math');
  const actualPresentations = actualMath.map((part) => presentation(part.latex, part.display));
  if (expectedMath.length !== actualMath.length || strict.flags.some((flag) =>
    ['math-span-count', 'unmatched-delimiter', 'unexpected-prose'].includes(flag))) found.add('segmentation-difference');
  if (strict.prose && !strict.prose.exact) found.add('prose-difference');
  const spans = expectedMath.map((reference, index) => {
    const actual = actualMath[index];
    const displayMode = { reference: reference.display, output: actual?.display ?? null };
    if (actual && reference.display !== actual.display) found.add('layout-difference');
    const expected = presentation(reference.latex, reference.display);
    const output = actualPresentations[index] ?? { kind: 'error' as const, error: 'Missing math span' };
    if (output.kind === 'error') found.add('rendering-failure');
    if (expected.kind === 'error' || output.kind === 'error') return { index, displayMode, reference: expected, output, symbols: null };
    const edits = editDistance(expected.symbols, output.symbols);
    if (edits) found.add('symbol-difference');
    if (expected.layout !== output.layout) found.add('layout-difference');
    if (JSON.stringify(expected.matrices) !== JSON.stringify(output.matrices)) found.add('matrix-shape-difference');
    if (JSON.stringify(expected.scripts) !== JSON.stringify(output.scripts)) found.add('script-structure-difference');
    if (JSON.stringify(expected.typography) !== JSON.stringify(output.typography)) found.add('typography-difference');
    return { index, displayMode, reference: expected, output,
      symbols: { edits, referenceCount: expected.symbols.length, outputCount: output.symbols.length } };
  });
  if (actualPresentations.some((part) => part.kind === 'error')) found.add('rendering-failure');
  if (!strict.pass && found.size === 0) found.add('strict-only-difference');
  return { strictPass: strict.pass, strictScored: strict.scored, strict,
    renderable: outcome.status === 'success' && !found.has('rendering-failure'),
    categories: [...found], spans,
    review: { status: 'unreviewed' as const, note: 'Diagnostic categories do not establish visual or semantic equivalence.' } };
}
export type OutcomeAnalysis = ReturnType<typeof analyzeOutcome>;

export function compareRuns(cases: AccuracyCase[], baseline: RunEntry[], candidate: RunEntry[]) {
  function index(entries: RunEntry[], label: string) {
    const values = new Map<string, AccuracyOutcome>();
    for (const entry of entries) {
      assert.ok(!values.has(entry.id), `Duplicate ${label} case ${entry.id}`);
      values.set(entry.id, entry.outcome);
    }
    return values;
  }
  const before = index(baseline, 'baseline'), after = index(candidate, 'candidate');
  const comparisons = cases.map((sample) => {
    const baselineOutcome = before.get(sample.id), candidateOutcome = after.get(sample.id);
    assert.ok(baselineOutcome, `Missing baseline case ${sample.id}`);
    assert.ok(candidateOutcome, `Missing candidate case ${sample.id}`);
    return { id: sample.id, role: sample.role, kind: sample.kind, tags: sample.tags,
      baseline: { outcome: baselineOutcome, analysis: analyzeOutcome(sample, baselineOutcome) },
      candidate: { outcome: candidateOutcome, analysis: analyzeOutcome(sample, candidateOutcome) } };
  });
  return { metric: 'strict corpus MathML and diagnostic glyph/layout comparison; not CDM',
    summary: { cases: cases.length,
      baselineStrictPass: comparisons.filter((entry) => entry.baseline.analysis.strictPass).length,
      candidateStrictPass: comparisons.filter((entry) => entry.candidate.analysis.strictPass).length,
      controlRegressions: comparisons.filter((entry) => entry.role === 'control' && entry.baseline.analysis.strictPass && !entry.candidate.analysis.strictPass).length,
      baselineRenderable: comparisons.filter((entry) => entry.baseline.analysis.renderable).length,
      candidateRenderable: comparisons.filter((entry) => entry.candidate.analysis.renderable).length,
      reviewed: 0 },
    cases: comparisons, reviewQueue: comparisons.filter((entry) => !entry.baseline.analysis.strictPass || !entry.candidate.analysis.strictPass ||
      entry.baseline.analysis.categories.length > 0 || entry.candidate.analysis.categories.length > 0),
  };
}
