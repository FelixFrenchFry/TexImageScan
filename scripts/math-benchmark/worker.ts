import { z } from 'zod';
import { cachedResponse, cacheReady, downloadModel } from '../../src/model-cache';
import { imageSchema } from '../../src/protocol';
import { assertImageHasContent } from '../../src/image';
import { requireGpu } from '../../src/gpu';
import { createPaddleEngine, normalizePaddleOutput, paddleOptionsSchema, paddleTokenCount, type PaddleEngine } from '../../src/paddle-engine';

const requestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prepare'), id: z.string() }),
  z.object({ type: z.enum(['recognize', 'preprocess']), id: z.string(), image: imageSchema,
    options: paddleOptionsSchema, margin: z.number().int().min(0).max(32).default(0) }),
]);
let engine: PaddleEngine | undefined;
let gpu = '';
let working = false;
let activeId = '';
const send = (value: unknown) => self.postMessage(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function initialize(id: string): Promise<PaddleEngine> {
  if (engine) return engine;
  gpu = await requireGpu(navigator.gpu);
  if (!(await cacheReady())) await downloadModel((detail) => send({ type: 'progress', id, detail }));
  const instance = await createPaddleEngine({
    fetchAsset: cachedResponse,
    onDeviceLost(info) { send({ type: 'error', id: activeId, error: `GPU device lost: ${JSON.stringify(info)}` }); },
  });
  const warmup = new OffscreenCanvas(28, 28);
  const context = warmup.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas unavailable');
  context.fillStyle = 'white'; context.fillRect(0, 0, 28, 28);
  await instance.recognizeCanvas(warmup, { task: 'formula', maxGeneratedTokens: 1 });
  engine = instance;
  return instance;
}

async function canvasFor(image: string, margin: number): Promise<OffscreenCanvas> {
  const bitmap = await createImageBitmap(await (await fetch(image)).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const width = bitmap.width + margin * 2, height = bitmap.height + margin * 2;
    if (width * height > 8_000_000) throw new Error('Crop exceeds the application pixel bound');
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = 'white'; context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, margin, margin);
    assertImageHasContent(context.getImageData(0, 0, width, height).data, 4);
    return canvas;
  } finally { bitmap.close(); }
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  const parsed = requestSchema.safeParse(event.data);
  if (!parsed.success || working) return;
  working = true;
  const request = parsed.data;
  activeId = request.id;
  try {
    if (request.type === 'prepare') {
      await initialize(request.id);
      send({ type: 'ready', id: request.id, gpu });
      return;
    }
    const started = performance.now();
    const canvas = await canvasFor(request.image, request.margin);
    if (request.type === 'preprocess') {
      const moduleUrl = new URL('/paddle/multimodal_ocr.mjs', self.location.href).href;
      const module: unknown = await import(/* @vite-ignore */ moduleUrl);
      if (!isRecord(module) || typeof module.preprocessImage !== 'function' || typeof module.multimodalPromptInputIds !== 'function')
        throw new Error('Preprocessing exports unavailable');
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const rgb = new Uint8Array(canvas.width * canvas.height * 3);
      for (let index = 0; index < canvas.width * canvas.height; index++)
        for (let channel = 0; channel < 3; channel++) rgb[index * 3 + channel] = rgba[index * 4 + channel] ?? 255;
      const value: unknown = module.preprocessImage(rgb, canvas.height, canvas.width, 3, request.options.preprocessing);
      const tensor = z.object({ gridThw: z.tuple([z.number(), z.number(), z.number()]), pixelValues: z.instanceof(Float32Array) }).parse(value);
      const bytes = new Uint8Array(tensor.pixelValues.buffer);
      const suffixIds = request.options.promptSuffixIds;
      if (!suffixIds) throw new Error('Parity preprocessing requires verified prompt token IDs');
      const inputIds: unknown = module.multimodalPromptInputIds(tensor.gridThw, {
        prefixIds: [100273, 2969, 93963, 93919, 101305], suffixIds,
      });
      const chunks = [];
      for (let index = 0; index < bytes.length; index += 8192)
        chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
      send({ type: 'preprocessed', id: request.id, imageGridThw: tensor.gridThw,
        pixelValuesShape: [tensor.pixelValues.length / 588, 588], pixelSha256: await sha256(bytes),
        pixelsBase64: btoa(chunks.join('')), inputIds: z.array(z.number().int()).parse(inputIds) });
      return;
    }
    const instance = await initialize(request.id);
    let firstTokenMs: number | null = null;
    const result = await instance.recognizeCanvas(canvas, {
      ...request.options,
      onToken() { firstTokenMs ??= performance.now() - started; },
    });
    send({ type: 'result', id: request.id, outcome: {
      status: 'success', output: normalizePaddleOutput(result.text, request.options.task),
      rawText: result.text,
      truncated: result.greedy.stopReason !== 'eos', stopReason: result.greedy.stopReason,
      tokenCount: paddleTokenCount(result), tokenIds: result.greedy.tokenIds,
      elapsedMs: performance.now() - started, firstTokenMs, gpu,
      visionTokens: result.visionTokens, promptTokens: result.promptTokens,
      generationMs: result.generationMs, tokensPerSecond: result.tokensPerSecond,
      decoderResidentWeightBytes: result.decoderResidentWeightBytes,
    } });
  } catch (error) {
    send({ type: 'error', id: request.id, error: error instanceof Error ? error.stack : String(error) });
  } finally { working = false; }
};
