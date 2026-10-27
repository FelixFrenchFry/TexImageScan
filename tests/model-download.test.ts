import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { downloadModel } from '../src/model-cache';

vi.mock('../src/model-manifest.json', () => ({
  default: {
    repository: 'test/model',
    revision: 'pinned',
    totalBytes: 6,
    files: ['config.json', 'weights'].map((path) => ({
      path,
      size: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    })),
  },
}));

const base = 'https://huggingface.co/test/model/resolve/pinned/';
const entries = new Map<string, Response>();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // native AbortSignal timers do not follow the Vitest clock
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
  entries.clear();
  entries.set(base + 'config.json', new Response('abc'));
  entries.set(base + '__verified__', new Response('pinned'));
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (key: string) => entries.get(key)?.clone(),
      delete: async (key: string) => entries.delete(key),
      put: async (key: string, response: Response) => {
        const bytes = await response.arrayBuffer();
        entries.set(key, new Response(bytes, { headers: response.headers }));
      },
    }),
    keys: async () => [],
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function startDownload() {
  const requested = Promise.withResolvers<{
    signal: AbortSignal;
    body: ReadableStreamDefaultController<Uint8Array>;
    headers: (status?: number) => void;
  }>();
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, options?: RequestInit) => {
    const signal = options?.signal;
    if (!signal) throw new Error('Expected a download abort signal');
    const headers = Promise.withResolvers<Response>();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener(
          'abort',
          () => {
            controller.error(signal.reason);
            headers.reject(signal.reason);
          },
          { once: true },
        );
        requested.resolve({
          signal,
          body: controller,
          headers: (status = 200) => headers.resolve(new Response(body, { status })),
        });
      },
    });
    return headers.promise;
  });
  const outcome = downloadModel(() => {}).then(() => null, (error: unknown) => error);
  return { ...(await requested.promise), outcome };
}

it('keeps downloading beyond fifteen minutes while headers and chunks arrive', async () => {
  const download = await startDownload();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  download.headers();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(download.signal.aborted).toBe(false);
  for (const character of ['a', 'b', 'c']) {
    download.body.enqueue(new TextEncoder().encode(character));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(download.signal.aborted).toBe(false);
  }
  download.body.close();
  expect(await download.outcome).toBeNull();
  expect(await entries.get(base + 'weights')?.text()).toBe('abc');
  expect(entries.has(base + '__verified__')).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['headers', 'body'])('aborts a download stalled waiting for %s', async (stage) => {
  const download = await startDownload();
  if (stage === 'body') {
    download.headers();
    download.body.enqueue(new TextEncoder().encode('a'));
  }
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(download.signal.aborted).toBe(true);
  expect(await download.outcome).toBe(download.signal.reason);
  expect(entries.has(base + 'weights')).toBe(false);
  expect(entries.has(base + '__verified__')).toBe(false);
  expect(await entries.get(base + 'config.json')?.text()).toBe('abc');
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the timeout after an HTTP failure', async () => {
  const download = await startDownload();
  download.headers(503);
  download.body.close();
  expect(await download.outcome).toMatchObject({ message: 'Model download failed (503): weights' });
  expect(download.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('stops the timeout before verifying a completed response', async () => {
  const download = await startDownload();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const verifying = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
    verifying.resolve();
    await release.promise;
    return digest(...args);
  });
  download.headers();
  download.body.enqueue(new TextEncoder().encode('abc'));
  download.body.close();
  await verifying.promise;
  try {
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(download.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release.resolve();
  }
  expect(await download.outcome).toBeNull();
});
