import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { openExtension } from './browser.mjs';
import { serveModelMirror } from './lib/model-mirror.mjs';
import { splitMath } from '../src/preview.ts';
import { scoreCase } from './lib/corpus.mjs';
import { hash } from './lib/corpus-files.mjs';

// test the shipped worker after running pnpm build
const directory = resolve('artifacts/math-smoke'),
  build = resolve(process.env.TEXIMAGESCAN_TEST_BUILD ?? '.output/chrome-mv3');
await mkdir(directory, { recursive: true });
const model = JSON.parse(await readFile('src/model-manifest.json')),
  corpus = JSON.parse(await readFile('tests/fixtures/samples/manifest.json')),
  generated = JSON.parse(await readFile('tests/fixtures/generated/manifest.json'));
const cases = [
  ...corpus.filter(sample => sample.kind === 'equation').map((sample) => ({
    ...sample,
    file: `tests/fixtures/samples/${sample.id}.png`,
    reference: {
      status: 'source-checked',
      segments: splitMath(sample.text)
        .map((part) => part.kind === 'math'
          ? { kind: 'math', latex: part.source, display: part.display }
          : { kind: 'text', text: part.source })
        .filter((part) => (part.text ?? part.latex).trim()),
    },
  })),
  {
    id: 'bold-vectors',
    kind: 'equation',
    file: 'tests/fixtures/generated/bold-vectors.png',
    reference: {
      status: 'source-checked',
      segments: [{ kind: 'math', latex: generated.latex, display: true }],
    },
  },
];
const report = {
  startedAt: new Date().toISOString(),
  model,
  testedExtension: build,
  unsafeWebgpuFlag: false,
  results: [],
  diagnostics: [],
  error: null,
};
let extension, page, mirror;
async function command(message, timeout = 180000) {
  return page.evaluate(
    ({ message, timeout }) => new Promise((resolve) => {
      const worker = window.__acceptanceWorker,
        id = crypto.randomUUID(), phases = [];
      let streamed = false, finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        worker.removeEventListener('message', listener);
        worker.removeEventListener('error', onError);
        resolve({ ...value, phases, streamed });
      };
      const listener = (event) => {
        const value = event.data;
        if (value.type === 'device-lost')
          return finish({ status: 'error', message: value.message });
        if (value.id !== id) return;
        if (value.type === 'progress') {
          phases.push(value.phase);
          if (value.phase === 'recognizing' && value.text) streamed = true;
        }
        if (value.type === 'ready') finish({ status: 'ready', gpu: value.gpu });
        if (value.type === 'failed') finish({ status: 'error', message: value.message });
        if (value.type === 'result') {
          const { image: _image, ...result } = value.result;
          finish({ status: 'success', ...result, output: result.original });
        }
      };
      const onError = (event) => finish({ status: 'error', message: event.message });
      const timer = setTimeout(() => finish({ status: 'timeout' }), timeout);
      worker.addEventListener('message', listener);
      worker.addEventListener('error', onError);
      worker.postMessage({ ...message, id });
    }),
    { message, timeout },
  );
}
async function image(file) {
  return `data:image/png;base64,${(await readFile(file)).toString('base64')}`;
}
async function run(sample) {
  const outcome = await command({
    type: 'recognize', image: await image(sample.file),
    name: sample.id + '.png', maxTokens: 2048,
  });
  assert.equal(outcome.status, 'success', outcome.message);
  assert.equal(outcome.mode, 'equation');
  assert.equal(outcome.task, 'equation');
  assert.equal(outcome.modelRevision, model.revision);
  assert.ok(outcome.original.trim());
  assert.ok(outcome.tokenCount > 0);
  assert.ok(outcome.firstTokenMs >= 0 && outcome.firstTokenMs !== null);
  assert.equal(outcome.truncated, false);
  assert.equal(outcome.streamed, true, 'Recognition must stream text before its result');
  const result = { sample: sample.id, outcome, score: scoreCase(sample, outcome) };
  report.results.push(result);
  await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${sample.id}: ${Math.round(outcome.elapsedMs)}ms, strict=${result.score.pass}`);
  return result;
}
try {
  const workers = (await readdir(join(build, 'assets'))).filter(
    (file) => file.startsWith('recognition.worker-') && file.endsWith('.js'),
  );
  assert.equal(workers.length, 1, 'Build must contain one production recognition worker');
  report.workerBundleSha256 = hash(await readFile(join(build, 'assets', workers[0])));
  extension = await openExtension({
    directory: build, profile: resolve(process.env.TEXIMAGESCAN_TEST_PROFILE ?? '.cache/production-profile'),
  });
  page = extension.page;
  report.browser = extension.context.browser().version();
  mirror = await serveModelMirror(extension.context, model);
  await page.evaluate((url) => {
    window.__acceptanceWorker = new Worker(url, { type: 'module' });
  }, `chrome-extension://${extension.id}/assets/${workers[0]}`);
  const ready = await command({ type: 'prepare' }, 600000);
  assert.equal(ready.status, 'ready', ready.message);
  report.gpu = ready.gpu;
  report.mirrorRequests = mirror.requests;
  await mirror.close();
  mirror = undefined;
  // run recognition offline from the verified model cache
  await extension.context.setOffline(true);
  report.networkDisabledBeforeInference = true;
  for (const sample of cases) await run(sample);


  // record quality failures even when the runtime checks pass
  report.quality = {
    attempted: report.results.length,
    strictPassed: report.results.filter((result) => result.score.pass).length,
    failures: report.results.filter((result) => !result.score.pass).map(({ sample, score }) => ({ sample, score })),
  };
  for (const id of ['energy']) {
    const result = report.results.find((result) => result.sample === id);
    assert.equal(result.score.pass, true, `${id} failed its source-checked reference`);
  }
  const vectors = report.results.find(result => result.sample === 'bold-vectors');
  assert.equal((vectors.outcome.original.match(/\\(?:boldsymbol|mathbf)\{x\}/g) ?? []).length, 4);
  const blank = await command({
    type: 'recognize', image: await image('tests/fixtures/samples/blank.png'),
    name: 'blank.png', maxTokens: 1024, 
  });
  assert.equal(blank.status, 'error');
  assert.match(blank.message, /blank/i);
  assert.equal(blank.streamed, false);
  report.diagnostics.push({ name: 'blank', outcome: blank });
  const limited = await command({
    type: 'recognize', image: await image('tests/fixtures/samples/aligned.png'),
    name: 'limited.png', maxTokens: 32, 
  });
  assert.equal(limited.status, 'success', limited.message);
  assert.equal(limited.truncated, true);
  assert.ok(limited.tokenCount <= 32 && limited.tokenCount > 0);
  report.diagnostics.push({ name: 'token-limit', outcome: limited });
} catch (error) {
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await mirror?.close();
  await extension?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ cases: report.results.length, error: report.error }, null, 2));
}
