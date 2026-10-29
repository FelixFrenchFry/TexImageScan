import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { Browser } from 'wxt/browser';
import manifest from '../src/model-manifest.json' with { type: 'json' };
import { stateSchema, type AppState, type PanelCommand, type RecognitionResult } from '../src/protocol.ts';
import { openExtension, waitForPanel } from './browser.mjs';
import { serveModelMirror } from './lib/model-mirror.mjs';

declare global {
  interface Window {
    chrome: Pick<typeof import('wxt/browser').browser, 'runtime'>;
    __migrationPort?: Browser.runtime.Port;
    __migrationEvents: unknown[];
  }
}

const args = process.argv.slice(2);
assert.ok(args.every((arg) => ['--preservation-only', '--recovery'].includes(arg)),
  'Usage: node scripts/test-paddle-migration.ts [--preservation-only] [--recovery]');
const profileRoot = resolve('.cache/paddle-migration/upgrade-profile');
await mkdir(profileRoot, { recursive: true });
// create a fresh profile for each run and keep existing profiles
const profile = await mkdtemp(join(profileRoot, 'run-'));
const build = resolve(process.env.TEXIMAGESCAN_TEST_BUILD ?? '.output/chrome-mv3');
const image = `data:image/png;base64,${(await readFile('tests/fixtures/samples/energy.png')).toString('base64')}`;
const legacy = {
  id: 'legacy-teleocr-scan', name: 'legacy-energy.png', image,
  original: '$E=mc^2$', edited: '$E=mc^2+1$',
  createdAt: '2026-10-01T12:00:00.000Z', elapsedMs: 4312, firstTokenMs: 123,
  tokenCount: 12, truncated: false, gpu: 'old',
  modelRevision: '3bbc0e0f541b2ddd6f2c238f3ee0493c982cb0ac',
  mode: 'auto', task: 'equation',
} satisfies RecognitionResult;
const legacyState = {
  model: 'ready', gpu: 'old', job: { kind: 'idle' }, capture: { kind: 'idle' },
  result: legacy, history: [], saveError: null,
  input: { id: legacy.id, name: legacy.name, image: legacy.image },
} satisfies AppState;
const oldCache = 'teximagescan-model-legacy', unrelatedCache = 'migration-unrelated-cache';
const report: {
  startedAt: string; profile: string; build: string; modelRevision: string;
  checks: string[]; mirrorRequests?: number; caches?: string[];
  recognition?: Omit<RecognitionResult, 'image'>; error: string | null; finishedAt?: string;
} = {
  startedAt: new Date().toISOString(), profile, build, modelRevision: manifest.revision,
  checks: [], error: null,
};
await mkdir('artifacts', { recursive: true });
let extension: Awaited<ReturnType<typeof openExtension>> | undefined;
let mirror: Awaited<ReturnType<typeof serveModelMirror>> | undefined;

async function observe(page: Page): Promise<void> {
  await waitForPanel(page);
  await page.evaluate(() => {
    window.__migrationEvents = [];
    const port = window.chrome.runtime.connect({ name: 'teximagescan-panel' });
    window.__migrationPort = port;
    port.onMessage.addListener((state: unknown) => {
      window.__migrationEvents.push(state);
      if (window.__migrationEvents.length > 64) window.__migrationEvents.shift();
    });
  });
  await expect.poll(async () => (await states(page)).length).toBeGreaterThan(0);
}
async function states(page: Page): Promise<AppState[]> {
  const values = await page.evaluate(() => window.__migrationEvents);
  return values.map((value) => stateSchema.parse(value));
}
async function state(page: Page): Promise<AppState> {
  const current = (await states(page)).at(-1);
  assert.ok(current, 'The native model host must publish its state');
  return current;
}
async function send(page: Page, message: PanelCommand, reset = true): Promise<void> {
  await page.evaluate(({ message, reset }) => {
    if (!window.__migrationPort) throw new Error('The test observation port is disconnected');
    if (reset) window.__migrationEvents = [];
    window.__migrationPort.postMessage(message);
  }, { message, reset });
}
async function command(page: Page, message: PanelCommand, timeout = 600_000): Promise<AppState> {
  await send(page, message);
  await expect.poll(async () => (await states(page)).some((value) => value.job.kind === 'running'),
    { timeout: 15_000 }).toBe(true);
  let detail = '';
  const progress = setInterval(() => {
    void state(page).then((current) => {
      if (current.job.kind === 'running' && current.job.detail !== detail) {
        detail = current.job.detail;
        console.log(detail);
      }
    }).catch(() => undefined);
  }, 5000);
  try {
    await expect.poll(async () => (await state(page)).job.kind, { timeout }).not.toBe('running');
    return await state(page);
  } finally { clearInterval(progress); }
}
function assertLegacy(current: AppState): void {
  assert.deepEqual(current.result, legacy, 'Legacy source, image, edits, metadata and model revision must survive');
  assert.ok(current.history.some((scan) => scan.id === legacy.id && scan.edited));
  assert.deepEqual(current.input, legacyState.input);
}

try {
  extension = await openExtension({ directory: build, profile });
  await observe(extension.page);
  assert.equal((await state(extension.page)).history.length, 0, 'The new test profile must have no saved scans');
  await extension.page.evaluate(async ({ legacyState, oldCache, unrelatedCache }) => {
    const request = indexedDB.open('teximagescan-prototype', 2);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      // this page uses the fresh test profile created above
      const transaction = db.transaction(['state', 'scans', 'images'], 'readwrite');
      const complete = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      transaction.objectStore('scans').clear();
      transaction.objectStore('images').clear();
      transaction.objectStore('state').put(legacyState, 'current');
      await complete;
    } finally { db.close(); }
    await (await caches.open(oldCache)).put('https://example.invalid/legacy', new Response('old-model'));
    await (await caches.open(unrelatedCache)).put('https://example.invalid/unrelated', new Response('keep-me'));
  }, { legacyState, oldCache, unrelatedCache });
  await extension.close();
  extension = undefined;

  extension = await openExtension({ directory: build, profile });
  const page = extension.page;
  await observe(page);
  assertLegacy(await state(page));
  // open the saved result from History after the fresh panel starts empty
  await page.getByRole('button', { name: 'Scan history', exact: true }).click();
  await page.getByRole('button', { name: `Open ${legacy.name}`, exact: true }).click();
  await page.getByRole('img', { name: `Source: ${legacy.name}`, exact: true }).waitFor();
  await page.locator('.scan-details summary').click();
  await expect(page.locator('.scan-metadata').getByText('previous model', { exact: true })).toBeVisible();
  const stored = await page.evaluate(async (id) => {
    const request = indexedDB.open('teximagescan-prototype', 2);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction(['state', 'scans', 'images']);
      const get = (store: string, key: string) => new Promise<unknown>((resolve, reject) => {
        const request = transaction.objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [workspace, metadata, image] = await Promise.all([
        get('state', 'current'), get('scans', id), get('images', id),
      ]);
      return { workspace, metadata, image };
    } finally { db.close(); }
  }, legacy.id);
  assert.ok(typeof stored.workspace === 'object' && stored.workspace !== null);
  assert.ok('resultId' in stored.workspace && stored.workspace.resultId === legacy.id);
  assert.equal('result' in stored.workspace, false, 'The embedded legacy result must be migrated');
  const { image: _legacyImage, ...metadata } = legacy;
  assert.deepEqual(stored.metadata, metadata);
  assert.equal(stored.image, legacy.image);
  const beforeCaches = await page.evaluate(() => caches.keys());
  assert.ok(beforeCaches.includes(oldCache));
  assert.ok(beforeCaches.includes(unrelatedCache));
  report.checks.push('Restart migrated the legacy embedded scan into scans/images and preserved its image, original, edits, metadata, revision, input and history. UI identifies the previous model.');

  if (!args.includes('--preservation-only')) {
    mirror = await serveModelMirror(extension.context, manifest);
    // Playwright cannot route offscreen requests on every Chrome version
    // seed raw bytes without a completion marker so production preparation verifies each file
    await page.evaluate(async ({ manifest, origin }) => {
      const cache = await caches.open(`teximagescan-model-${manifest.revision}`);
      const prefix = `/${manifest.repository}/resolve/${manifest.revision}/`;
      for (const file of manifest.files) {
        const response = await fetch(origin + prefix + file.path);
        if (!response.ok) throw new Error(`Mirror failed for ${file.path}`);
        await cache.put(`https://huggingface.co${prefix}${file.path}`, response);
      }
    }, { manifest, origin: mirror.origin });
    await extension.context.setOffline(true);
    const prepared = await command(page, { type: 'prepare' });
    assert.equal(prepared.job.kind, 'idle', JSON.stringify(prepared.job));
    assert.equal(prepared.model, 'ready');
    assertLegacy(prepared);
    report.mirrorRequests = mirror.requests;
    await mirror.close();
    mirror = undefined;
    const cached = await page.evaluate(async ({ manifest, unrelatedCache }) => {
      const names = await caches.keys();
      const cacheName = `teximagescan-model-${manifest.revision}`;
      const cache = await caches.open(cacheName);
      const base = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/`;
      const marker = await cache.match(base + '__verified__');
      const files = await Promise.all(manifest.files.map(async (file) => {
        const response = await cache.match(base + file.path);
        return { path: file.path, size: response?.headers.get('content-length') ?? null };
      }));
      const unrelated = await (await caches.open(unrelatedCache)).match('https://example.invalid/unrelated');
      return { names, marker: marker ? await marker.text() : null, files, unrelated: unrelated ? await unrelated.text() : null };
    }, { manifest, unrelatedCache });
    assert.equal(cached.names.includes(oldCache), false);
    assert.deepEqual(cached.names.filter((name) => name.startsWith('teximagescan-model-')), [`teximagescan-model-${manifest.revision}`]);
    assert.equal(cached.marker, manifest.revision);
    assert.deepEqual(cached.files, manifest.files.map((file) => ({ path: file.path, size: String(file.size) })));
    assert.equal(cached.unrelated, 'keep-me');
    report.caches = cached.names;
    report.checks.push('Real Paddle preparation verified every pinned cache entry, removed the obsolete owned cache, retained the unrelated cache and preserved the saved legacy scan.');

    if (args.includes('--recovery')) {
      await extension.context.setOffline(true);
      await send(page, { type: 'recognize', name: 'cancelled-upgrade.png', image, maxTokens: 256 });
      await expect.poll(async () => (await states(page)).some((value) => value.job.kind === 'running'), { timeout: 15_000 }).toBe(true);
      await send(page, { type: 'cancel' }, false);
      await expect.poll(async () => (await state(page)).job.kind).toBe('cancelled');
      assertLegacy(await state(page));
      const recovered = await command(page, { type: 'recognize', name: 'paddle-upgrade.png', image, maxTokens: 256 });
      assert.equal(recovered.job.kind, 'idle', JSON.stringify(recovered.job));
      assert.ok(recovered.result);
      assert.notEqual(recovered.result.id, legacy.id);
      assert.equal(recovered.result.modelRevision, manifest.revision);
      assert.match(recovered.result.original, /E\s*=\s*m\s*c\^(?:2|\{2\})/);
      assert.ok(recovered.history.some((scan) => scan.id === legacy.id));
      const { image: _image, ...recognition } = recovered.result;
      report.recognition = recognition;
      await send(page, { type: 'open-scan', id: legacy.id });
      await expect.poll(async () => (await states(page)).at(-1)?.result?.id).toBe(legacy.id);
      assertLegacy(await state(page));
      report.checks.push('Offline cancellation preserved the legacy scan; a fresh worker retried from cache, recorded the Paddle revision, and retained the editable old scan in history.');
    }
  }
  await page.screenshot({ path: 'artifacts/paddle-migration.png', fullPage: true });
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  await mirror?.close();
  await extension?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile('artifacts/paddle-migration.json', JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
