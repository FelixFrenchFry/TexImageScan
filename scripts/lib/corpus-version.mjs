import assert from 'node:assert/strict';

export function parseCorpusOptions(input) {
  const args = [...input],
    index = args.indexOf('--corpus');
  if (index < 0) return { directory: 'tests/corpus', args };
  const value = args[index + 1];
  assert.ok(value && !value.startsWith('--'), 'Missing --corpus directory');
  args.splice(index, 2);
  assert.ok(!args.includes('--corpus'), 'Duplicate --corpus option');
  const directory = value.replaceAll('\\', '/');
  assert.match(
    directory,
    /^tests\/corpus(?:-[a-zA-Z0-9-]+)?$/,
    'Corpus directory must be a version under tests/',
  );
  return { directory, args };
}

export function checkCorpusProtocol(manifest) {
  if (manifest.version === 1) {
    assert.equal(manifest.cases.length, 120, 'Expected 120 original v1 crops');
    return;
  }
  assert.equal(manifest.version, 2, 'Unsupported corpus version');
  const { expected, minFamilies } = manifest.protocol ?? {};
  assert.ok(expected && Number.isInteger(minFamilies), 'Missing corpus protocol');
  const families = new Map();
  for (const sample of manifest.cases) {
    assert.ok(
      expected[sample.split] && Object.hasOwn(expected[sample.split], sample.kind),
      `Unexpected count category: ${sample.id}`,
    );
    if (families.has(sample.documentId))
      assert.equal(families.get(sample.documentId), sample.split, 'Document family split leakage');
    families.set(sample.documentId, sample.split);
    if (sample.origin) {
      assert.ok(
        sample.origin.manifestSha256?.match(/^[a-f0-9]{64}$/) &&
          sample.origin.caseId &&
          sample.origin.originalSplit &&
          sample.origin.previouslyEvaluated === true,
        `Incomplete imported lineage: ${sample.id}`,
      );
      assert.equal(
        sample.split,
        'development',
        'Previously evaluated material cannot enter fresh validation',
      );
    }
  }
  for (const [split, kinds] of Object.entries(expected))
    for (const [kind, count] of Object.entries(kinds))
      assert.equal(
        manifest.cases.filter((c) => c.split === split && c.kind === kind).length,
        count,
        `Wrong count: ${split}/${kind}`,
      );
  assert.ok(
    families.size >= minFamilies,
    `Too few document families: ${families.size}/${minFamilies}`,
  );
  if (manifest.protocol.importedCases !== undefined)
    assert.equal(
      manifest.cases.filter((c) => c.origin).length,
      manifest.protocol.importedCases,
      'Wrong imported-case count',
    );
}

export function checkImportedCase(sample, parent, parentSha256) {
  assert.ok(
    parent &&
      sample.origin?.caseId === parent.id &&
      sample.origin?.manifestSha256 === parentSha256 &&
      sample.origin?.originalSplit === parent.split,
    'Imported lineage does not match parent',
  );
  assert.deepEqual(sample.image, parent.image, 'Imported image/pixels changed');
  assert.deepEqual(sample.reference, parent.reference, 'Imported reference changed');
}

export function evaluationSplit(version, requested, allowValidation = false) {
  const split = requested ?? (version === 2 ? 'development' : 'all');
  assert.ok(['all', 'development', 'heldout'].includes(split), 'Invalid evaluation split');
  assert.ok(
    version !== 2 || split === 'development' || allowValidation,
    'Fresh validation requires --allow-validation after the prompt is fixed',
  );
  return split;
}
