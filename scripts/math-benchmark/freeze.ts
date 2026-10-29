import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sha256, readAccuracyManifest } from './dataset.ts';
import { collectFreezeSources } from './freeze-sources.ts';

const [manifestPath, output] = process.argv.slice(2);
assert.ok(manifestPath && output, 'Usage: node scripts/math-benchmark/freeze.ts HELDOUT_MANIFEST OUTPUT');
const { manifest, manifestSha256 } = await readAccuracyManifest(manifestPath);
assert.equal(manifest.purpose, 'math-heldout');
const sourceHashes = Object.fromEntries(await Promise.all((await collectFreezeSources()).map(async file => [file, sha256(await readFile(file))])));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), manifestSha256,
  variants: ['baseline'], maxTokens: 2048, sourceHashes,
  decision: 'Native Formula Recognition prompt, native pixels, greedy decoding. No automatic retries. Heldout baseline only; do not tune on its outputs.' }, null, 2) + '\n', { flag: 'wx' });
console.log(output);
