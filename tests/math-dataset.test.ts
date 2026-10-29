import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sha256, readAccuracyManifest } from '../scripts/math-benchmark/dataset';

it('refuses modified frozen input bytes before inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paddle-dataset-'));
  await writeFile(join(root, 'input.png'), 'modified');
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, purpose: 'development', provenance: {}, cases: [{
    id: 'one', kind: 'equation', role: 'hard', tags: [], image: { file: 'input.png', sha256: sha256('original') },
    reference: { status: 'approved', segments: [{ kind: 'math', latex: 'x', display: true }] },
  }] }));
  await expect(readAccuracyManifest(join(root, 'manifest.json'), root)).rejects.toThrow(/Changed image/);
});

it('refuses rewritten validation references even when the image is unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paddle-freeze-'));
  await writeFile(join(root, 'input.png'), 'unchanged');
  const original = { version: 1, purpose: 'fresh-validation', provenance: {}, cases: [{
    id: 'one', kind: 'equation', role: 'fresh', tags: [], image: { file: 'input.png', sha256: sha256('unchanged') },
    reference: { status: 'approved', segments: [{ kind: 'math', latex: 'x', display: true }] },
  }] };
  await writeFile(join(root, 'manifest-freeze.json'), JSON.stringify({ manifestSha256: sha256(JSON.stringify(original)) }));
  const changed = { ...original, cases: original.cases.map((entry) => ({ ...entry,
    reference: { ...entry.reference, segments: entry.reference.segments.map((span) => ({ ...span, latex: 'y' })) },
  })) };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(changed));
  await expect(readAccuracyManifest(join(root, 'manifest.json'), root)).rejects.toThrow(/Frozen manifest changed/);
});
