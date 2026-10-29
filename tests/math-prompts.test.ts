import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

it('loads verified math prompt profiles without an ignored experiment directory', async () => {
  await mkdir('test-results', { recursive: true });
  const directory = await mkdtemp(resolve('test-results/prompt-checkout-'));
  try {
    const url = pathToFileURL(resolve('scripts/math-benchmark/provenance.ts')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { readMathPrompts } = await import(${JSON.stringify(url)}); const prompts = await readMathPrompts(); process.stdout.write(JSON.stringify({ sha256: prompts.sha256, formula: prompts.profiles.nativeFormula?.promptSuffixIds }));`],
    { cwd: directory, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sha256: '39d91d0e3c905caaa670428710f929a9be3e60dd56e4a7ab1b99f544d76c5ba2',
      formula: [101306, 59352, 93514, 93963, 23, 92267, 93963, 23],
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);
