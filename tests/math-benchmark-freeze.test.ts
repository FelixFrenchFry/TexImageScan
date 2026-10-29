import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, type AccuracyManifest } from '../scripts/math-benchmark/dataset';
import { collectFreezeSources } from '../scripts/math-benchmark/freeze-sources';

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });

it.each(['missing', 'variant', 'changed source', 'omitted variant', 'omitted variant with parity'])(
  'checks the heldout freeze before launching a browser: %s', async problem => {
    await mkdir('test-results', { recursive: true });
    const directory = await mkdtemp('test-results/math-freeze-'); temporary.push(directory);
    const file = 'tests/fixtures/samples/energy.png';
    const manifest: AccuracyManifest = { version: 1, purpose: 'math-heldout', provenance: {}, cases: [{
      id: 'fixture', kind: 'equation', role: 'fresh', tags: [], image: { file, sha256: sha256(await readFile(file)) },
      reference: { status: 'approved', segments: [{ kind: 'math', latex: 'E=mc^2', display: true }] },
    }] };
    const bytes = JSON.stringify(manifest), manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, bytes);
    const frozenPath = join(directory, 'freeze.json');
    await writeFile(frozenPath, JSON.stringify({ manifestSha256: sha256(bytes), maxTokens: 2048,
      variants: ['baseline'], sourceHashes: { [file]: '0'.repeat(64) } }));
    const output = join(directory, 'run');
    const result = spawnSync(process.execPath, ['scripts/math-benchmark/run.ts', manifestPath, output,
      ...(problem.startsWith('omitted variant') ? [] : [problem === 'variant' ? 'concise' : 'baseline']),
      ...(problem === 'omitted variant with parity' ? ['--parity'] : []),
      ...(problem === 'missing' ? [] : ['--freeze', frozenPath])],
    { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(problem === 'missing' ? 'Math heldout requires --freeze'
      : problem === 'variant' ? 'Variant not approved' : 'Heldout configuration changed');
    await expect(access(output)).rejects.toThrow();
  }, 15_000,
);
it('freezes the runtime bridge, concurrency helper, scoring dependency and lockfile', async () => {
  const files = await collectFreezeSources();
  for (const path of ['public/paddle/pkg/pvlc_runtime_web.js', 'public/paddle/ocr_concurrency.mjs', 'src/preview.ts', 'pnpm-lock.yaml'])
    expect(files).toContain(path);
  expect(files.some(path => path.startsWith('public/paddle/pkg/snippets/') && path.endsWith('.js'))).toBe(true);
}, 15_000);
