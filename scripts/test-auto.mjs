import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { openExtension } from './browser.mjs';
import { recognitionInstructions } from '../src/recognition-prompts.ts';
import { splitMath } from '../src/preview.ts';
import { scoreCase } from './lib/corpus.mjs';
import { hash } from './lib/corpus-files.mjs';
const directory = resolve('artifacts/single-pass'),
  project = resolve('.cache/single-pass-project'),
  profile = resolve('.cache/single-pass-profile');
await mkdir(directory, { recursive: true });
await mkdir(project, { recursive: true });
const sourceFiles = [
  'src/recognition.worker.ts',
  'src/recognition-prompts.ts',
  'src/protocol.ts',
  'src/teleocr-image.ts',
  'src/model-manifest.json',
  'src/model-cache.ts',
];
const sourceHashes = Object.fromEntries(
  await Promise.all(sourceFiles.map(async (file) => [file, hash(await readFile(file))])),
);
const model = JSON.parse(await readFile('src/model-manifest.json')),
  corpus = JSON.parse(await readFile('tests/fixtures/samples/manifest.json'));
const generated = JSON.parse(await readFile('tests/fixtures/generated/manifest.json'));
const cases = [
  ...corpus.map((sample) => ({
    ...sample,
    file: `tests/fixtures/samples/${sample.id}.png`,
    reference: {
      status: 'source-checked',
      segments: splitMath(sample.text)
        .map((part) =>
          part.kind === 'math'
            ? { kind: 'math', latex: part.source, display: part.display }
            : { kind: 'text', text: part.source },
        )
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
  sourceHashes,
  instructions: recognitionInstructions,
  unsafeWebgpuFlag: false,
  results: [],
  diagnostics: [],
  error: null,
};
let extension, server, page;
function replaceOnce(source, anchor, replacement) {
  assert.equal(source.split(anchor).length, 2, 'Acceptance instrumentation anchor changed');
  return source.replace(anchor, replacement);
}
async function command(message, timeout = 180000) {
  return page.evaluate(
    ({ message, timeout }) =>
      new Promise((resolve) => {
        const worker = window.__acceptanceWorker,
          id = crypto.randomUUID(),
          generations = [],
          phases = [];
        let streamed = false;
        const finish = (value) => {
          clearTimeout(timer);
          worker.removeEventListener('message', listener);
          worker.removeEventListener('error', onError);
          resolve({ ...value, generations, phases, streamed });
        };
        const listener = (event) => {
          const value = event.data;
          if (value.type === 'device-lost')
            return finish({ status: 'error', message: value.message });
          if (value.id !== id) return;
          if (value.type === 'acceptance-generation') generations.push(value.instruction);
          if (value.type === 'progress') {
            phases.push(value.phase);
            if (value.phase === 'recognizing' && value.text) streamed = true;
          }
          if (value.type === 'ready') finish({ status: 'ready', gpu: value.gpu });
          if (value.type === 'failed') finish({ status: 'error', message: value.message });
          if (value.type === 'result') {
            const { image, ...result } = value.result;
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
async function run(sample, mode = 'auto') {
  const image = `data:image/png;base64,${(await readFile(sample.file)).toString('base64')}`;
  const outcome = await command({
    type: 'recognize',
    image,
    name: sample.id + '.png',
    maxTokens: 1024,
    task: mode,
  });
  assert.equal(outcome.status, 'success', outcome.message);
  assert.equal(outcome.generations.length, 1, 'Each recognition must generate exactly once');
  assert.equal(outcome.generations[0], recognitionInstructions[mode]);
  assert.equal(outcome.mode, mode);
  assert.equal(outcome.routing, undefined);
  assert.ok(!outcome.phases.includes('classifying'));
  if (mode === 'auto') assert.equal(outcome.task, undefined);
  else assert.equal(outcome.task, mode);
  const result = { sample: sample.id, mode, outcome, score: scoreCase(sample, outcome) };
  report.results.push(result);
  await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    `${sample.id} ${mode}: ${Math.round(outcome.elapsedMs)}ms, generations=1, strict=${result.score.pass}`,
  );
  return result;
}
try {
  for (const name of ['src', 'entrypoints', 'public', 'assets'])
    await cp(resolve(name), join(project, name), { recursive: true });
  for (const name of ['package.json', 'tsconfig.json', 'wxt.config.ts'])
    await cp(resolve(name), join(project, name));
  let worker = await readFile('src/recognition.worker.ts', 'utf8');
  worker = replaceOnce(
    worker,
    'let working = false;',
    "let working = false;\nlet acceptanceId = ''; ",
  );
  worker = replaceOnce(
    worker,
    'const command = parsed.data;',
    'const command = parsed.data;\n  acceptanceId = command.id;',
  );
  worker = replaceOnce(
    worker,
    '  await model.generate(',
    "  self.postMessage({ type: 'acceptance-generation', id: acceptanceId, instruction });\n  await model.generate(",
  );
  await writeFile(join(project, 'src/recognition.worker.ts'), worker);
  report.instrumentedWorkerSha256 = hash(worker);
  const prefix = `/${model.repository}/resolve/${model.revision}/`;
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname,
      file = model.files.find((file) => path === prefix + file.path);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Length': file.size,
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    createReadStream(resolve('.model-cache', path.slice(1)))
      .on('error', () => response.destroy())
      .pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const build = spawnSync(
    process.execPath,
    [resolve('node_modules/wxt/dist/cli/index.mjs'), 'build', project],
    {
      env: { ...process.env, WXT_MODEL_HOST: `http://127.0.0.1:${server.address().port}` },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  await writeFile(join(directory, 'build.log'), build.stdout + build.stderr);
  assert.equal(build.status, 0, 'Acceptance build failed');
  const output = join(project, '.output/chrome-mv3-benchmark'),
    workers = (await readdir(join(output, 'assets'))).filter(
      (file) => file.startsWith('recognition.worker-') && file.endsWith('.js'),
    );
  assert.equal(workers.length, 1);
  report.workerBundleSha256 = hash(await readFile(join(output, 'assets', workers[0])));
  extension = await openExtension({ directory: output, profile, gpu: false });
  page = extension.page;
  await page.evaluate((url) => {
    window.__acceptanceWorker = new Worker(url, { type: 'module' });
  }, `chrome-extension://${extension.id}/assets/${workers[0]}`);
  const ready = await command({ type: 'prepare' }, 600000);
  assert.equal(ready.status, 'ready', ready.message);
  assert.equal(ready.generations.length, 0);
  report.gpu = ready.gpu;
  await new Promise((resolve) => server.close(resolve));
  server = undefined;
  report.mirrorStoppedBeforeInference = true;
  for (const sample of cases) await run(sample);
  await run(
    cases.find((sample) => sample.id === 'bold-vectors'),
    'equation',
  );
  await run(
    cases.find((sample) => sample.id === 'mixed-energy'),
    'mixed',
  );
  const vector = report.results.find(
      (result) => result.sample === 'bold-vectors' && result.mode === 'auto',
    ),
    passage = report.results.find(
      (result) => result.sample === 'mixed-energy' && result.mode === 'auto',
    );
  assert.equal(vector.score.pass, true);
  assert.equal(passage.score.pass, true);
  assert.equal(passage.outcome.streamed, true);
  const blank = await command({
    type: 'recognize',
    image: `data:image/png;base64,${(await readFile('tests/fixtures/samples/blank.png')).toString('base64')}`,
    name: 'blank.png',
    maxTokens: 1024,
    task: 'auto',
  });
  assert.equal(blank.status, 'error');
  assert.match(blank.message, /blank/i);
  assert.equal(blank.generations.length, 0);
  report.diagnostics.push({ name: 'blank-before-generation', outcome: blank });
} catch (error) {
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await extension?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  report.sourceUnchanged = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [file, hash(await readFile(file)) === sourceHashes[file]]),
    ),
  );
  assert.ok(Object.values(report.sourceUnchanged).every(Boolean), 'Production source changed');
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ cases: report.results.length, error: report.error }, null, 2));
}
