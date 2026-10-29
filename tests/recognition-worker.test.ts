import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workerEventSchema, type WorkerEvent } from '../src/protocol';
import type { PaddleOptions } from '../src/paddle-engine';

const runtime = vi.hoisted(() => ({
  create: vi.fn(), recognize: vi.fn(), cached: vi.fn(), download: vi.fn(), ready: vi.fn(),
}));
vi.mock('../src/model-cache', () => ({
  cachedResponse: runtime.cached, downloadModel: runtime.download, cacheReady: runtime.ready,
}));
vi.mock('../src/gpu', () => ({ requireGpu: async () => 'test GPU' }));
vi.mock('../src/paddle-engine', async (original) => ({
  ...await original<typeof import('../src/paddle-engine')>(), createPaddleEngine: runtime.create,
}));

const post = vi.fn();
const close = vi.fn();
let pixels = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
let dimensions = { width: 2, height: 1 };
const command = { type: 'recognize', id: 'job', name: 'crop.png', image: 'data:image/png;base64,AAAA', maxTokens: 32, task: 'auto' };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  dimensions = { width: 2, height: 1 };
  pixels = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  vi.stubGlobal('self', { postMessage: post, onmessage: null });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('fetch', async () => new Response('image'));
  vi.stubGlobal('createImageBitmap', async () => ({ ...dimensions, close }));
  vi.stubGlobal('OffscreenCanvas', class {
    width: number;
    height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext() {
      return { fillStyle: '', fillRect() {}, drawImage() {}, getImageData: () => ({ data: pixels }) };
    }
  });
  runtime.ready.mockResolvedValue(true);
  runtime.cached.mockResolvedValue(new Response('verified'));
  runtime.download.mockResolvedValue(undefined);
  runtime.create.mockResolvedValue({ recognizeCanvas: runtime.recognize });
  runtime.recognize.mockImplementation(async (_canvas, options: PaddleOptions) => {
    options.onToken?.('\\[x\\]', 1);
    return { text: '\\[x\\]', greedy: { tokenIds: [10, 2], stopReason: 'eos' } };
  });
  await import('../src/recognition.worker');
});
afterEach(() => vi.unstubAllGlobals());
async function send(message: unknown): Promise<WorkerEvent[]> {
  post.mockClear();
  if (!self.onmessage) throw new Error('Worker message handler missing');
  await Reflect.apply(self.onmessage, self, [{ data: message }]);
  return post.mock.calls.map(([value]) => workerEventSchema.parse(value));
}

it('rejects a blank crop before loading or generating and always closes the bitmap', async () => {
  pixels.fill(255);
  const events = await send(command);
  expect(events.at(-1)).toMatchObject({ type: 'failed', id: 'job', message: expect.stringContaining('blank') });
  expect(runtime.create).not.toHaveBeenCalled();
  expect(runtime.recognize).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
it('rejects an oversized image before allocating inference resources', async () => {
  dimensions = { width: 4000, height: 2001 };
  expect((await send(command)).at(-1)).toMatchObject({ type: 'failed', message: expect.stringContaining('8 million') });
  expect(runtime.create).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
it('warms once and recognizes formulas even when an old caller supplies a mode', async () => {
  expect((await send({ type: 'prepare', id: 'prepare' })).at(-1)).toMatchObject({ type: 'ready' });
  expect(runtime.recognize.mock.calls[0]?.[1]).toMatchObject({ task: 'formula', maxGeneratedTokens: 1 });
  for (const task of ['auto', 'mixed', 'equation']) {
    const events = await send({ ...command, task });
    expect(runtime.recognize.mock.lastCall?.[1]).toMatchObject({ task: 'formula', maxGeneratedTokens: 32 });
    expect(events.some((event) => event.type === 'progress' && event.text === '\\[x\\]')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'result', result: { tokenCount: 1, truncated: false, mode: 'equation', raw: '\\[x\\]' } });
  }
  expect(runtime.create).toHaveBeenCalledOnce();
  expect(runtime.download).toHaveBeenCalledOnce();
});
it('retains the exact generated source separately from display delimiters', async () => {
  await send({ type: 'prepare', id: 'prepare' });
  runtime.recognize.mockResolvedValueOnce({ text: '  x_2  ', greedy: { tokenIds: [10, 2], stopReason: 'eos' } });
  expect((await send(command)).at(-1)).toMatchObject({ type: 'result', result: { raw: '  x_2  ', original: '\\[x_2\\]', edited: '\\[x_2\\]' } });
});
it('reports the actual termination reason when the output cap is reached', async () => {
  await send({ type: 'prepare', id: 'prepare' });
  runtime.recognize.mockResolvedValueOnce({ text: 'partial', greedy: { tokenIds: [10], stopReason: 'max_steps' } });
  expect((await send(command)).at(-1)).toMatchObject({ type: 'result', result: { truncated: true } });
});
it('rejects unlisted model assets and forwards loss of the runtime GPU device', async () => {
  await send({ type: 'prepare', id: 'prepare' });
  const hooks = runtime.create.mock.calls[0]?.[0];
  if (!hooks) throw new Error('Engine initialization hooks missing');
  runtime.cached.mockResolvedValueOnce(new Response('', { status: 404 }));
  await expect(hooks.fetchAsset('https://example.com/weights')).rejects.toThrow('pinned local model');
  hooks.onDeviceLost({ message: 'test loss' });
  expect(post.mock.lastCall?.[0]).toMatchObject({ type: 'device-lost', message: expect.stringContaining('test loss') });
});
