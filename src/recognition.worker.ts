import manifest from './model-manifest.json';
import { cachedResponse, cacheReady, downloadModel } from './model-cache';
import { createModelLoadProgress } from './model-progress';
import { workerCommandSchema, type WorkerEvent } from './protocol';
import { requireGpu } from './gpu';
import { assertImageHasContent } from './image';
import { createPaddleEngine, normalizePaddleOutput, paddleTokenCount, type PaddleEngine } from './paddle-engine';

let engine: PaddleEngine | undefined;
let gpuDescription: string | undefined;
let working = false;
const send = (event: WorkerEvent) => self.postMessage(event);

async function loadModel(id: string): Promise<PaddleEngine> {
  if (engine) return engine;
  if (!(await cacheReady()))
    throw new Error('Download the model first. Cached files are missing or incomplete.');
  const verified = createModelLoadProgress(manifest.files);
  send({ type: 'progress', id, phase: 'loading', detail: 'Initializing Paddle WebGPU engine…', fraction: null, text: '' });
  const instance = await createPaddleEngine({
    async fetchAsset(url) {
      const response = await cachedResponse(url);
      if (!response.ok) throw new Error('File not in the pinned local model');
      const path = new URL(url).pathname.split(`/resolve/${manifest.revision}/`)[1];
      const fraction = path ? verified(path) : undefined;
      if (fraction !== undefined)
        send({ type: 'progress', id, phase: 'loading', detail: 'Loading verified model data…', fraction, text: '' });
      return response;
    },
    onDeviceLost(info) {
      const message = typeof info === 'object' && info !== null && 'message' in info && typeof info.message === 'string'
        ? info.message : 'GPU device unavailable';
      send({ type: 'device-lost', message: `WebGPU device was lost: ${message}. Retry recognition to reload the model automatically.` });
    },
  });
  // upload and compile before reporting the model as ready
  const canvas = new OffscreenCanvas(28, 28);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Image decoding is unavailable');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await instance.recognizeCanvas(canvas, { task: 'formula', maxGeneratedTokens: 1 });
  engine = instance;
  return instance;
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  const parsed = workerCommandSchema.safeParse(event.data);
  if (!parsed.success || working) return;
  const command = parsed.data;
  working = true;
  try {
    gpuDescription ??= await requireGpu(navigator.gpu);
    if (command.type === 'prepare') {
      const started = performance.now();
      await downloadModel((detail, fraction) => send({ type: 'progress', id: command.id, phase: 'downloading', detail, fraction, text: '' }));
      await loadModel(command.id);
      send({ type: 'ready', id: command.id, gpu: gpuDescription, loadMs: performance.now() - started });
      return;
    }
    const started = performance.now();
    const bitmap = await createImageBitmap(await (await fetch(command.image)).blob(), {
      colorSpaceConversion: 'none', premultiplyAlpha: 'none',
    });
    let canvas: OffscreenCanvas;
    try {
      if (bitmap.width * bitmap.height > 8_000_000)
        throw new Error('Use an image with at most 8 million pixels. Crop the equation more tightly.');
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Image decoding is unavailable');
      context.fillStyle = 'white';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0);
      assertImageHasContent(context.getImageData(0, 0, canvas.width, canvas.height).data, 4);
    } finally { bitmap.close(); }
    const instance = await loadModel(command.id);
    const task = 'formula';
    let firstTokenAt: number | null = null;
    let lastUpdate = 0;
    send({ type: 'progress', id: command.id, phase: 'recognizing', detail: 'Reading image…', fraction: null, text: '' });
    const result = await instance.recognizeCanvas(canvas, {
      task, maxGeneratedTokens: command.maxTokens,
      onToken(text, tokens) {
        firstTokenAt ??= performance.now();
        if (performance.now() - lastUpdate > 100) {
          send({ type: 'progress', id: command.id, phase: 'recognizing', detail: `${tokens} tokens`, fraction: null, text });
          lastUpdate = performance.now();
        }
      },
    });
    const text = normalizePaddleOutput(result.text, task);
    send({ type: 'result', id: command.id, result: {
      id: command.id, name: command.name, image: command.image, raw: result.text, original: text, edited: text,
      createdAt: new Date().toISOString(), elapsedMs: performance.now() - started,
      firstTokenMs: firstTokenAt === null ? null : firstTokenAt - started,
      tokenCount: paddleTokenCount(result), truncated: result.greedy.stopReason !== 'eos',
      gpu: gpuDescription, modelRevision: manifest.revision, mode: 'equation', task: 'equation',
    } });
  } catch (error) {
    engine = undefined;
    send({ type: 'failed', id: command.id, message: error instanceof Error ? error.message.slice(0, 1800) : 'Local recognition failed' });
  } finally { working = false; }
};
