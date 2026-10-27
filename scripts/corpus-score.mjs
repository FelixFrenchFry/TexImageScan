import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { corpusArgs, hash, readCorpus } from './lib/corpus-files.mjs';
import { summarize } from './lib/corpus.mjs';

const file = corpusArgs[0];
if (!file || corpusArgs.length !== 1)
  throw new Error('Usage: pnpm corpus:score [--corpus tests/corpus-v2] path/to/report.json');
const bytes = await readFile(file),
  report = JSON.parse(bytes);
const { manifest, manifestSha256 } = await readCorpus({ frozen: true });
assert.equal(report.manifestSha256, manifestSha256, 'Report belongs to a different corpus');
const cases = report.summary?.cases;
assert.ok(Array.isArray(cases) && cases.length, 'Report has no selected cases');
assert.equal(report.summary.counts.selected, cases.length, 'Selected cases are missing');
assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, 'Duplicate case outcomes');
const entries = cases.map((record) => {
  const sample = manifest.cases.find((c) => c.id === record.id);
  assert.ok(sample, `Unknown case ${record.id}`);
  const outcome = record.outcome;
  assert.ok(
    ['success', 'error', 'timeout', 'not-run'].includes(outcome?.status),
    'Invalid outcome',
  );
  if (outcome.status === 'success')
    assert.equal(typeof outcome.output, 'string', 'Missing raw output');
  return { sample, outcome };
});
const { cases: scoredCases, ...summary } = summarize(entries);
const strata = {};
for (const key of ['split', 'kind', 'publisher', 'documentId'])
  strata[key] = Object.fromEntries(
    [...new Set(entries.map((e) => e.sample[key]))].map((value) => {
      const { cases, ...summary } = summarize(entries.filter((e) => e.sample[key] === value));
      return [value, summary];
    }),
  );
console.log(
  JSON.stringify(
    {
      input: file,
      inputSha256: hash(bytes),
      manifestSha256,
      scorerSha256: hash(await readFile('scripts/lib/corpus.mjs')),
      summary,
      strata,
      reviewCases: scoredCases
        .filter((c) => !c.score.pass)
        .map((c) => ({
          id: c.id,
          status: c.outcome.status,
          flags: c.score.flags,
          reason: c.score.reason,
        })),
    },
    null,
    2,
  ),
);
