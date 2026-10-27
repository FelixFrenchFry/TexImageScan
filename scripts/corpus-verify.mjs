import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { corpusArgs, corpusPath, hash, readCorpus } from './lib/corpus-files.mjs';
import { compareMath } from './lib/corpus.mjs';

const freeze = corpusArgs.includes('--freeze');
const { manifest, manifestSha256 } = await readCorpus({
  frozen: !freeze && corpusArgs.includes('--frozen'),
});
const unsupported = [];
for (const sample of manifest.cases)
  for (const span of sample.reference.segments.filter((s) => s.kind === 'math')) {
    const result = compareMath(span.latex, span.latex, span.display);
    if (!result.referenceRenderable)
      unsupported.push({ id: sample.id, latex: span.latex, error: result.referenceError });
  }
const by = (key) =>
  Object.fromEntries(
    [...new Set(manifest.cases.map((s) => s[key]))].map((value) => [
      value,
      manifest.cases.filter((s) => s[key] === value).length,
    ]),
  );
if (freeze) {
  const auditBytes = await readFile(corpusPath('audit.json'));
  const audit = JSON.parse(auditBytes);
  assert.equal(
    new Set(audit.cases.map((c) => c.id)).size,
    manifest.cases.length,
    'Audit must cover all cases',
  );
  for (const sample of manifest.cases)
    assert.ok(
      audit.cases.some((c) => c.id === sample.id && c.imageSha256 === sample.image.sha256),
      'Audit must match image hashes',
    );
  try {
    await readFile(corpusPath('freeze.json'));
    throw new Error(
      'Already frozen. Keep the first freeze and create a new corpus version for changed references.',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(
    corpusPath('freeze.json'),
    JSON.stringify(
      {
        version: manifest.version,
        frozenAt: new Date().toISOString(),
        manifestSha256,
        auditSha256: hash(auditBytes),
        cases: manifest.cases.length,
        policy:
          'Freeze before first inference. No prompt, preprocessing, or router tuning against held-out results.',
      },
      null,
      2,
    ) + '\n',
  );
}
console.log(
  JSON.stringify(
    {
      cases: manifest.cases.length,
      documents: manifest.documents.length,
      split: by('split'),
      kind: by('kind'),
      publisher: by('publisher'),
      manifestSha256,
      unsupportedMath: unsupported,
    },
    null,
    2,
  ),
);
