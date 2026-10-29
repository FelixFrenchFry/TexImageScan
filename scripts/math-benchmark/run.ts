import assert from 'node:assert/strict';
import { cp, mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import model from '../../src/model-manifest.json' with { type: 'json' };
import { paddleOptionsSchema } from '../../src/paddle-engine.ts';
import { openExtension } from '../browser.mjs';
import { serveModelMirror } from '../lib/model-mirror.mjs';
import { readAccuracyManifest, sha256 } from './dataset.ts';
import { installAccuracyClient, recognizePrepared } from './client.ts';
import { readMathPrompts } from './prompts.ts';
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    freeze: { type: 'string' },
    parity: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
const [manifestPath, output, variantList = 'baseline'] = positionals;
const variants = variantList.split(',');
const usage = 'Usage: pnpm benchmark MANIFEST OUTPUT_DIRECTORY [baseline,ocr-only,concise] [--freeze CONFIG] [--parity]';
if (values.help) { console.log(usage); process.exit(0); }
assert.ok(manifestPath && output, usage);
const parity = values.parity ?? false;
assert.ok(variants.every((name) => ['baseline', 'ocr-only', 'concise'].includes(name)), usage);
const { manifest, manifestSha256 } = await readAccuracyManifest(manifestPath);
assert.ok(['math-development', 'math-heldout', 'native-parity'].includes(manifest.purpose), 'Use a current math split or an explicit native-parity manifest. Historical experiments require their archived source.');
if (manifest.purpose === 'math-heldout') {
  const path = values.freeze;
  assert.ok(path, 'Math heldout requires --freeze CONFIG frozen before heldout inference');
  const frozen = z.object({ manifestSha256: z.string(), maxTokens: z.literal(2048), variants: z.array(z.string()),
    sourceHashes: z.record(z.string(), z.string()) }).parse(JSON.parse(await readFile(path, 'utf8')));
  assert.equal(manifestSha256, frozen.manifestSha256, 'Wrong heldout manifest');
  assert.ok(variants.every(name => frozen.variants.includes(name)), 'Variant not approved before heldout inference');
  for (const [file, expected] of Object.entries(frozen.sourceHashes))
    assert.equal(sha256(await readFile(file)), expected, `Heldout configuration changed: ${file}`);
}
const prompts = await readMathPrompts();
const build = resolve('.cache/paddle-accuracy/extension');
await mkdir(build, { recursive: true });
// keep a stable extension path to reuse its verified 2 GB model cache
// lock before replacing files that a running browser could still use
const lockPath = resolve('.cache/paddle-accuracy/browser.lock');
const lock = await open(lockPath, 'wx');
try {
await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
await cp('.output/chrome-mv3', build, { recursive: true });
await cp('public/paddle', join(build, 'paddle'), { recursive: true });
await writeFile(join(build, 'accuracy.html'), '<!doctype html><html><meta charset="utf-8"><title>Paddle accuracy</title><body>Paddle-only local accuracy experiment.</body></html>');
const require = createRequire(import.meta.url);
const viteModule: unknown = await import(pathToFileURL(createRequire(require.resolve('wxt')).resolve('vite')).href);
assert.ok(typeof viteModule === 'object' && viteModule && 'build' in viteModule && typeof viteModule.build === 'function');
await viteModule.build({ configFile: false, logLevel: 'error', build: { outDir: join(build, 'assets'), emptyOutDir: false,
  rolldownOptions: { input: resolve('scripts/math-benchmark/worker.ts'), output: { entryFileNames: 'accuracy-worker.js' } } } });
const runtimeFiles = (await readdir(join(build, 'paddle'), { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
runtimeFiles.push(join(build, 'assets/accuracy-worker.js'));
const runtimeHashes = Object.fromEntries(await Promise.all(runtimeFiles.map(async (file) => [
  file.slice(build.length + 1).replaceAll('\\', '/'), sha256(await readFile(file)),
])));
await mkdir(output, { recursive: true });
for (const variant of variants) {
  // keep existing runs, including incomplete ones
  const claim = await open(join(output, `${variant}.json`), 'wx');
  await claim.close();
}
const profile = resolve('.cache/paddle-accuracy/browser-profile');
const extension = await openExtension({ directory: build, profile });
const page = extension.page;
page.on('console', (message) => { if (message.type() === 'error') console.error(message.text().slice(0, 600)); });
try {
  await page.goto(`chrome-extension://${extension.id}/accuracy.html`);
  const cached = await page.evaluate(async (revision) => !!(await (await caches.open(`teximagescan-model-${revision}`))
    .match(`https://huggingface.co/glebkudr/PaddleOCR-VL-1.6-WebGPU/resolve/${revision}/__verified__`)), model.revision);
  if (!cached) {
    console.log('Seeding local model cache. Production worker will verify all bytes.');
    const mirror = await serveModelMirror(extension.context, model);
    try {
      await page.evaluate(async ({ model, origin }) => {
        const cache = await caches.open(`teximagescan-model-${model.revision}`);
        const prefix = `/${model.repository}/resolve/${model.revision}/`;
        for (const file of model.files) {
          const response = await fetch(origin + prefix + file.path);
          if (!response.ok) throw new Error(`Local mirror: ${file.path}`);
          await cache.put(`https://huggingface.co${prefix}${file.path}`, response);
        }
      }, { model, origin: mirror.origin });
    } finally { await mirror.close(); }
  }
  await extension.context.setOffline(true);
  await page.evaluate(installAccuracyClient, {});
  for (const variant of variants) {
    await page.evaluate(() => window.resetAccuracyWorker());
    console.log(`${variant}: preparing`);
    const prepared = z.object({ type: z.literal('ready'), gpu: z.string().min(1) }).passthrough().parse(
      await page.evaluate(() => window.accuracyCommand({ type: 'prepare', id: 'prepare' })));
    const report = { version: 1, variant, manifestPath, manifestSha256, startedAt: new Date().toISOString(), finishedAt: null as string | null,
      browser: extension.context.browser()?.version(),
      modelRevision: model.revision, promptFileSha256: prompts.sha256, runtimeHashes, prepared,
      offline: true, cases: [] as { id: string; configuration: unknown; outcome: unknown; preprocessing?: unknown }[] };
    for (const sample of manifest.cases) {
      const formula = sample.kind === 'equation' && variant !== 'ocr-only';
      const profileName = formula ? variant === 'concise' ? 'conciseFormula' : 'nativeFormula' : 'nativeOCR';
      const prompt = prompts.profiles[profileName]; assert.ok(prompt);
      const options = paddleOptionsSchema.parse({ task: prompt.task, maxGeneratedTokens: 2048,
        promptSuffixIds: prompt.promptSuffixIds });
      const request = { id: sample.id, image: `data:image/png;base64,${(await readFile(sample.image.file)).toString('base64')}`,
        options, margin: 0 };
      let preprocessing: unknown;
      if (parity) {
        const tensor = z.object({ imageGridThw: z.array(z.number()), pixelValuesShape: z.array(z.number()),
          pixelSha256: z.string(), pixelsBase64: z.string(), inputIds: z.array(z.number().int()) }).parse(
            await page.evaluate((request) => window.accuracyCommand({ ...request, type: 'preprocess' }), request));
        const { pixelsBase64, ...metadata } = tensor;
        const bytes = Buffer.from(pixelsBase64, 'base64');
        assert.equal(sha256(bytes), tensor.pixelSha256);
        const file = `${variant}-${sample.id}.f32.bin`;
        await writeFile(join(output, file), bytes);
        preprocessing = { ...metadata, file };
      }
      let outcome: unknown;
      try {
        outcome = z.object({ outcome: z.unknown() }).parse(
          await page.evaluate(recognizePrepared, { request: { ...request, type: 'recognize' }, gpu: prepared.gpu })).outcome;
      } catch (error) { outcome = { status: 'error', error: String(error) }; }
      report.cases.push({ id: sample.id, configuration: { profileName, options, margin: request.margin }, outcome,
        ...(preprocessing ? { preprocessing } : {}) });
      await writeFile(join(output, `${variant}.json`), JSON.stringify(report, null, 2) + '\n');
      console.log(`${variant}: ${report.cases.length}/${manifest.cases.length} ${sample.id}`);
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, `${variant}.json`), JSON.stringify(report, null, 2) + '\n');
  }
} finally { await extension.close(); }
} finally { await lock.close(); await unlink(lockPath); }
