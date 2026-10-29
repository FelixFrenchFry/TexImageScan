import { expect, it } from 'vitest';
import { auditHtml, parseRunEntries } from '../scripts/math-benchmark/report';
import { compareRuns } from '../scripts/math-benchmark/metrics';
import type { AccuracyManifest } from '../scripts/math-benchmark/dataset';

it('renders reference and raw outputs while escaping model HTML in the audit artifact', () => {
  const manifest: AccuracyManifest = { version: 1, purpose: 'development', provenance: {}, cases: [{
    id: 'one', kind: 'equation', role: 'hard', tags: ['greek'], image: { file: 'one.png', sha256: '0'.repeat(64) },
    reference: { status: 'approved', segments: [{ kind: 'math', latex: '\\alpha', display: true }] },
  }] };
  const comparison = compareRuns(manifest.cases,
    [{ id: 'one', outcome: { status: 'success', output: '\\alpha', truncated: false } }],
    [{ id: 'one', outcome: { status: 'success', output: '<script>bad()</script>', truncated: false } }]);
  const html = auditHtml({ manifest, comparison, css: '', images: new Map([['one', 'data:image/png;base64,AAAA']]), identity: 'test' });
  expect(html).toContain('Reference');
  expect(html).toContain('data:image/png;base64,AAAA');
  expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
  expect(html).not.toContain('<script>bad()</script>');
  expect(html).toContain('No human equivalence decisions have been made');
  expect(html).toContain('Export review JSON');
});

it('rejects a run bound to another manifest instead of silently comparing stale cases', () => {
  expect(() => parseRunEntries({ manifestSha256: '0'.repeat(64), cases: [] }, '1'.repeat(64))).toThrow(/different manifest/);
});
