import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/model-manifest.json', () => ({ default: {
  repository: 'test/model', revision: 'pinned', totalBytes: 3,
  files: [{ path: 'weights.bin', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }],
} }));
import { downloadModel, cacheReady } from '../src/model-cache';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('downloads verified assets from the pinned model URL with anonymous requests', async () => {
  const entries = new Map<string, Response>();
  vi.stubEnv('WXT_MODEL_HOST', 'http://retired-benchmark.invalid');
  vi.stubGlobal('caches', { open: async () => ({
    match: async (key: string) => entries.get(key)?.clone(),
    put: async (key: string, value: Response) => { entries.set(key, value); },
    delete: async (key: string) => entries.delete(key),
  }), keys: async () => [] });
  const requests: { url: string; credentials?: RequestCredentials; referrerPolicy?: ReferrerPolicy }[] = [];
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
    requests.push({ url, credentials: options.credentials, referrerPolicy: options.referrerPolicy });
    return new Response('abc', { headers: { 'content-length': '3' } });
  });
  await downloadModel(() => undefined);
  expect(requests).toEqual([{ url: 'https://huggingface.co/test/model/resolve/pinned/weights.bin', credentials: 'omit', referrerPolicy: 'no-referrer' }]);
  expect(await cacheReady()).toBe(true);
});
