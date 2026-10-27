import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openExtension } from './browser.mjs';
import { corpusArgs, corpusPath, hash, readCorpus } from './lib/corpus-files.mjs';
import { summarize } from './lib/corpus.mjs';
import { evaluationSplit } from './lib/corpus-version.mjs';

const args = corpusArgs.filter((arg) => arg !== '--allow-validation');
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`Missing ${name} value`);
  return args[index + 1];
};
for (let index = 0; index < args.length; index += 2)
  if (!['--split', '--mode', '--out', '--case'].includes(args[index]))
    throw new Error(`Unknown option: ${args[index]}`);
const mode = option('--mode', 'auto');
if (!['auto', 'manual'].includes(mode)) throw new Error('Use --mode auto|manual');
const { manifest, manifestSha256 } = await readCorpus({ frozen: true });
const split = evaluationSplit(
  manifest.version,
  option('--split'),
  corpusArgs.includes('--allow-validation'),
);
const selected = manifest.cases.filter(
  (sample) =>
    (split === 'all' || sample.split === split) &&
    (!option('--case', '') || sample.id === option('--case', '')),
);
if (!selected.length) throw new Error('Empty evaluation selection');
const output = resolve(
  option('--out', `artifacts/corpus${manifest.version === 2 ? '-v2' : ''}-${mode}.json`),
);
await mkdir(dirname(output), { recursive: true });
const entries = selected.map((sample) => ({
  sample,
  outcome: { status: 'not-run', reason: 'pending' },
}));
const hashes = {};
for (const file of [
  'scripts/lib/corpus.mjs',
  'scripts/corpus-evaluate.mjs',
  'src/recognition-prompts.ts',
  'src/teleocr-image.ts',
  'src/recognition.worker.ts',
  '.output/chrome-mv3/manifest.json',
])
  hashes[file] = hash(await readFile(file));
const buildFiles = {};
for (const file of (
  await readdir('.output/chrome-mv3', { recursive: true, withFileTypes: true })
).filter((file) => file.isFile())) {
  const path = resolve(file.parentPath, file.name);
  buildFiles[path.slice(resolve('.output/chrome-mv3').length + 1).replaceAll('\\', '/')] = hash(
    await readFile(path),
  );
}
const report = {
  version: 1,
  startedAt: new Date().toISOString(),
  manifestSha256,
  mode,
  split,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHashes: hashes,
  testedExtension: {
    directory: '.output/chrome-mv3',
    files: buildFiles,
    sha256: hash(JSON.stringify(Object.entries(buildFiles).sort(([a], [b]) => a.localeCompare(b)))),
  },
  model: JSON.parse(await readFile('src/model-manifest.json', 'utf8')),
  gpu: null,
  unsafeWebgpuFlag: false,
  maxTokens: 2048,
  timeoutMs: 180000,
  error: null,
};
let extension;
async function save() {
  report.summary = summarize(entries);
  report.strata = {};
  for (const key of ['split', 'kind', 'publisher', 'documentId']) {
    report.strata[key] = Object.fromEntries(
      [...new Set(selected.map((sample) => sample[key]))].map((value) => {
        const { cases, ...summary } = summarize(
          entries.filter((entry) => entry.sample[key] === value),
        );
        return [value, summary];
      }),
    );
  }
  const documents = Object.values(report.strata.documentId);
  report.documentMacro = {
    documents: documents.length,
    passRate:
      documents.reduce(
        (sum, d) => sum + (d.counts.scored ? d.counts.passed / d.counts.scored : 0),
        0,
      ) / documents.length,
    note: 'Unscored documents contribute zero to this conservative rate; inspect per-document denominators.',
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
await save();
try {
  extension = await openExtension({ profile: resolve('.cache/production-profile'), gpu: false });
  const { page } = extension;
  await page.evaluate(() => {
    window.__corpusPort = chrome.runtime.connect({ name: 'teximagescan-panel' });
    window.__corpusPort.onMessage.addListener((state) => {
      if (state.job) window.__corpusState = state;
    });
  });
  await page.waitForFunction(() => window.__corpusState);
  async function command(message) {
    return page.evaluate(
      ({ message, timeout }) =>
        new Promise((resolve) => {
          const start = performance.now();
          let jobId, phase;
          const finish = (value) => {
            clearTimeout(timer);
            window.__corpusPort.onMessage.removeListener(listener);
            resolve({ ...value, wallMs: performance.now() - start });
          };
          const listener = (state) => {
            if (!state.job) return;
            if (state.job.kind === 'running') {
              jobId ??= state.job.id;
              if (state.job.id === jobId) phase = state.job.phase;
              return;
            }
            if (!jobId) return;
            if (state.job.kind !== 'idle') {
              finish({ status: 'error', phase, message: state.job.message ?? state.job.kind });
              return;
            }
            if (message.type === 'prepare') {
              finish({ status: 'prepared', gpu: state.gpu });
              return;
            }
            // a failed command can leave stale output in state
            if (state.result?.id !== jobId || state.result?.name !== message.name) {
              finish({ status: 'error', phase, message: 'Stale or missing recognition result' });
              return;
            }
            const { image: _image, ...result } = state.result;
            finish({ status: 'success', phase, ...result, output: result.original });
          };
          const timer = setTimeout(
            () => finish({ status: 'timeout', phase, message: 'Recognition deadline exceeded' }),
            timeout,
          );
          window.__corpusPort.onMessage.addListener(listener);
          window.__corpusPort.postMessage(message);
        }),
      { message, timeout: report.timeoutMs },
    );
  }
  let prepared = await command({ type: 'prepare' });
  if (prepared.status !== 'prepared')
    throw new Error(`Model preparation failed: ${JSON.stringify(prepared)}`);
  report.gpu = prepared.gpu;
  for (const entry of entries) {
    const bytes = await readFile(corpusPath(entry.sample.image.file));
    const image = `data:image/png;base64,${bytes.toString('base64')}`;
    entry.outcome = await command({
      type: 'recognize',
      name: `corpus-${entry.sample.id}.png`,
      image,
      maxTokens: report.maxTokens,
      task: mode === 'auto' ? 'auto' : entry.sample.expectedTask,
    });
    const result = entry.outcome;
    console.log(
      `${entry.sample.id}: ${result.status}, task=${result.task ?? 'unavailable'}, ${(result.wallMs / 1000).toFixed(2)}s`,
    );
    await save();
    if (result.status !== 'success') {
      await page.evaluate(() => window.__corpusPort.postMessage({ type: 'cancel' }));
      await page.waitForFunction(() => window.__corpusState.job.kind !== 'running', null, {
        timeout: 15000,
      });
      prepared = await command({ type: 'prepare' });
      if (prepared.status !== 'prepared')
        throw new Error(
          `Cannot recover model after ${entry.sample.id}: ${JSON.stringify(prepared)}`,
        );
    }
  }
} catch (error) {
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const entry of entries)
    if (entry.outcome.status === 'not-run')
      entry.outcome.reason = report.error ?? 'Run stopped before this case';
  report.finishedAt = new Date().toISOString();
  await extension?.close();
  await save();
}
console.log(
  JSON.stringify(
    {
      output,
      counts: report.summary.counts,
      routing: report.summary.routing,
      latencyMs: report.summary.latencyMs,
    },
    null,
    2,
  ),
);
// quality mismatches affect scores while execution failures still fail the run
if (report.summary.counts.error || report.summary.counts.timeout || !report.summary.complete)
  process.exitCode = 1;
