import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { validateManifest } from './corpus.mjs';
import { parseCorpusOptions, checkCorpusProtocol, checkImportedCase } from './corpus-version.mjs';

const options = parseCorpusOptions(process.argv.slice(2));
export const corpusArgs = options.args;
export const corpusRoot = resolve(options.directory);
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function corpusPath(file) {
  const path = resolve(corpusRoot, file);
  assert.ok(path.startsWith(corpusRoot + sep), `Path outside corpus: ${file}`);
  return path;
}

export async function readCorpus({ frozen = false, complete = true } = {}) {
  const bytes = await readFile(corpusPath('manifest.json'));
  const manifest = JSON.parse(bytes);
  validateManifest(manifest);
  if (complete) checkCorpusProtocol(manifest);
  if (manifest.version === 2)
    assert.deepEqual(
      (await readdir(corpusPath('images'))).sort(),
      manifest.cases.map((sample) => sample.image.file.slice('images/'.length)).sort(),
      'Image directory must match the manifest exactly; remove abandoned capture files before freezing',
    );
  if (manifest.protocol?.parentDirectory) {
    const { directory } = parseCorpusOptions(['--corpus', manifest.protocol.parentDirectory]);
    const parentBytes = await readFile(resolve(directory, 'manifest.json'));
    assert.equal(
      hash(parentBytes),
      manifest.protocol.parentManifestSha256,
      'Frozen parent manifest changed',
    );
    const parent = JSON.parse(parentBytes);
    for (const sample of manifest.cases.filter((c) => c.origin))
      checkImportedCase(
        sample,
        parent.cases.find((c) => c.id === sample.origin.caseId),
        hash(parentBytes),
      );
  }
  const sourceIds = new Set(),
    hashes = new Set();
  for (const document of manifest.documents) {
    assert.ok(!sourceIds.has(document.id), `Duplicate source: ${document.id}`);
    sourceIds.add(document.id);
    for (const [file, expected] of [
      [document.snapshot, document.htmlSha256],
      [document.originalSnapshot, document.originalHtmlSha256],
    ]) {
      assert.equal(
        hash(gunzipSync(await readFile(corpusPath(file)))),
        expected,
        `Changed source snapshot: ${file}`,
      );
    }
    if (document.licenseSnapshot)
      assert.equal(
        hash(gunzipSync(await readFile(corpusPath(document.licenseSnapshot)))),
        document.licenseHtmlSha256,
        `Changed license evidence: ${document.id}`,
      );
    assert.ok(document.url.startsWith('https://') && document.licenseUrl.startsWith('https://'));
  }
  for (const sample of manifest.cases) {
    assert.ok(sourceIds.has(sample.sourceId), `Missing source: ${sample.id}`);
    const document = manifest.documents.find((document) => document.id === sample.sourceId);
    assert.equal(sample.split, document.split, `Split mismatch: ${sample.id}`);
    assert.equal(sample.documentId, document.family, `Family mismatch: ${sample.id}`);
    const bytes = await readFile(corpusPath(sample.image.file));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `Not PNG: ${sample.id}`);
    assert.equal(hash(bytes), sample.image.sha256, `Changed image: ${sample.id}`);
    assert.equal(bytes.readUInt32BE(16), sample.image.width);
    assert.equal(bytes.readUInt32BE(20), sample.image.height);
    assert.ok(!hashes.has(sample.image.sha256), `Duplicate original image: ${sample.id}`);
    hashes.add(sample.image.sha256);
    assert.ok(
      ['equation', 'mixed', 'text'].includes(sample.kind),
      `Invalid content kind: ${sample.id}`,
    );
    assert.ok(sample.reference?.segments?.length, `Missing reference: ${sample.id}`);
    for (const segment of sample.reference.segments) {
      assert.ok(['text', 'math'].includes(segment.kind));
      assert.ok(typeof (segment.kind === 'text' ? segment.text : segment.latex) === 'string');
      assert.ok(
        (segment.kind === 'text' ? segment.text : segment.latex).trim(),
        `Empty reference span: ${sample.id}`,
      );
    }
    const math = sample.reference.segments.filter((s) => s.kind === 'math').length;
    assert.ok(
      sample.kind === 'equation'
        ? math === 1 && sample.reference.segments.length === 1
        : sample.kind === 'mixed'
          ? math > 0
          : math === 0,
      `Reference kind mismatch: ${sample.id}`,
    );
  }
  const manifestSha256 = hash(bytes);
  if (frozen) {
    const freeze = JSON.parse(await readFile(corpusPath('freeze.json'), 'utf8'));
    assert.equal(freeze.manifestSha256, manifestSha256, 'Manifest changed after freeze');
    const audit = await readFile(corpusPath('audit.json'));
    assert.equal(freeze.auditSha256, hash(audit), 'Audit changed after freeze');
    const checked = JSON.parse(audit);
    assert.equal(checked.cases.length, manifest.cases.length, 'Incomplete audit');
    for (const sample of manifest.cases)
      assert.ok(
        checked.cases.some(
          (entry) => entry.id === sample.id && entry.imageSha256 === sample.image.sha256,
        ),
        'Case not audited',
      );
    for (const sheet of checked.contactSheets)
      assert.equal(
        hash(await readFile(corpusPath(sheet.file))),
        sheet.sha256,
        `Changed audit sheet: ${sheet.file}`,
      );
  }
  return { manifest, manifestSha256 };
}
