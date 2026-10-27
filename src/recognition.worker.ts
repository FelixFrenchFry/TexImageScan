import {
  Qwen2_5_VLForConditionalGeneration,
  Qwen2_5_VLProcessor,
  env,
  RawImage,
  TextStreamer,
} from '@huggingface/transformers';
import runtimeMjs from 'ort-runtime/ort-wasm-simd-threaded.asyncify.mjs?url';
import runtimeWasm from 'ort-runtime/ort-wasm-simd-threaded.asyncify.wasm?url';
import manifest from './model-manifest.json';
import { cachedResponse, cacheReady, downloadModel, modelFile } from './model-cache';
import { createModelLoadProgress } from './model-progress';
import { workerCommandSchema, type WorkerEvent } from './protocol';
import { configureGpu, requireGpu } from './gpu';
import { prepareTeleocrPixels } from './teleocr-image';
import { recognitionInstructions } from './recognition-prompts';

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useFSCache = false;
env.useWasmCache = false;
// tokenizer discovery probes the main revision without forwarding the pin
// pin every library request, including discovery probes
env.remotePathTemplate = `{model}/resolve/${manifest.revision}/`;
// inference reads verified cache entries while downloads use native fetch
let reportModelFile: ((path: string) => void) | undefined;
env.fetch = async (input) => {
  const request = String(input);
  const response = await cachedResponse(request);
  const path = modelFile(request);
  if (response.ok && path) reportModelFile?.(path);
  return response;
};
const gpuOptions = configureGpu(navigator.userAgent, env.backends.onnx.webgpu);
const wasm = env.backends.onnx.wasm;
if (!wasm) throw new Error('The bundled ONNX WebAssembly runtime is missing');
wasm.wasmPaths = {
  mjs: new URL(runtimeMjs, self.location.href).href,
  wasm: new URL(runtimeWasm, self.location.href).href,
};
wasm.numThreads = 1;
wasm.proxy = false;

let model:
  | Awaited<ReturnType<typeof Qwen2_5_VLForConditionalGeneration.from_pretrained>>
  | undefined;
let processor: Awaited<ReturnType<typeof Qwen2_5_VLProcessor.from_pretrained>> | undefined;
let gpuContext: Awaited<ReturnType<typeof requireGpu>> | undefined;
let working = false;

const send = (event: WorkerEvent) => self.postMessage(event);

async function loadModel(id: string, gpu: Awaited<ReturnType<typeof requireGpu>>): Promise<void> {
  if (model && processor) return;
  if (!(await cacheReady()))
    throw new Error('Download the model first. Cached files are missing or incomplete.');
  const started = performance.now();
  send({
    type: 'progress',
    id,
    phase: 'loading',
    detail: 'Loading tokenizer and image processor…',
    fraction: null,
    text: '',
  });
  const options = { revision: manifest.revision };
  processor = await Qwen2_5_VLProcessor.from_pretrained(manifest.repository, options);
  const verified = createModelLoadProgress(
    manifest.files.filter((file) => file.path.startsWith('onnx/')),
  );
  send({
    type: 'progress',
    id,
    phase: 'loading',
    detail: 'Loading model data…',
    fraction: 0,
    text: '',
  });
  reportModelFile = (path) => {
    const fraction = verified(path);
    if (fraction === undefined) return;
    send({
      type: 'progress',
      id,
      phase: 'loading',
      detail: fraction === 1 ? 'Creating WebGPU sessions…' : 'Loading model data…',
      fraction: fraction === 1 ? null : fraction,
      text: '',
    });
  };
  try {
    model = await Qwen2_5_VLForConditionalGeneration.from_pretrained(manifest.repository, {
      ...options,
      device: 'webgpu',
      dtype: 'q4f16',
      session_options: gpu.sessionOptions,
    });
  } finally {
    reportModelFile = undefined;
  }
  send({
    type: 'progress',
    id,
    phase: 'loading',
    detail: `Model initialized in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    fraction: 1,
    text: '',
  });
}

async function infer(
  image: RawImage,
  instruction: string,
  maxTokens: number,
  onText?: (text: string, tokens: number) => void,
) {
  if (!model || !processor) throw new Error('Model initialization did not finish');
  const prompt = processor.apply_chat_template(
    [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: [{ type: 'image' }, { type: 'text', text: instruction }] },
    ],
    { tokenize: false, add_generation_prompt: true },
  );
  const inputs = await processor(prompt, [image]);
  const tokenizer = processor.tokenizer;
  if (!tokenizer) throw new Error('The pinned processor did not load its tokenizer');
  let text = '',
    tokenCount = 0;
  let firstTokenAt: number | null = null;
  let lastUpdate = 0;
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    callback_function(chunk) {
      text += chunk;
      if (onText && performance.now() - lastUpdate > 100) {
        onText(text, tokenCount);
        lastUpdate = performance.now();
      }
    },
    token_callback_function(tokens) {
      tokenCount += tokens.length;
      firstTokenAt ??= performance.now();
    },
  });
  await model.generate({
    ...inputs,
    max_new_tokens: maxTokens,
    do_sample: false,
    use_cache: true,
    streamer,
  });
  return { text: text.trim(), tokenCount, firstTokenAt };
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  const parsed = workerCommandSchema.safeParse(event.data);
  if (!parsed.success || working) return;
  const command = parsed.data;
  working = true;
  try {
    if (!gpuContext) {
      gpuContext = await requireGpu(navigator.gpu, gpuOptions);
      const backend = env.backends.onnx.webgpu;
      if (backend) backend.adapter = gpuContext.adapter;
      void gpuContext.device.lost.then((info) =>
        send({
          type: 'device-lost',
          message: `WebGPU device was lost: ${info.message || info.reason}. Retry recognition to reload the model automatically.`,
        }),
      );
    }
    const gpu = gpuContext;
    const gpuDescription = gpu.description;
    if (command.type === 'prepare') {
      const started = performance.now();
      await downloadModel((detail, fraction) =>
        send({
          type: 'progress',
          id: command.id,
          phase: 'downloading',
          detail,
          fraction,
          text: '',
        }),
      );
      await loadModel(command.id, gpu);
      send({
        type: 'ready',
        id: command.id,
        gpu: gpuDescription,
        loadMs: performance.now() - started,
      });
      return;
    }
    const started = performance.now();
    const blob = await (await fetch(command.image)).blob();
    const bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const pixels = bitmap.width * bitmap.height;
    let preparedImage;
    try {
      if (pixels > 8_000_000)
        throw new Error(
          'Use an image with at most 8 million pixels. Crop the passage more tightly.',
        );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image decoding is unavailable');
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      preparedImage = prepareTeleocrPixels(data, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
    const image = new RawImage(preparedImage.data, preparedImage.width, preparedImage.height, 3);
    await loadModel(command.id, gpu);
    send({
      type: 'progress',
      id: command.id,
      phase: 'recognizing',
      detail: 'Reading image…',
      fraction: null,
      text: '',
    });
    const result = await infer(
      image,
      recognitionInstructions[command.task],
      command.maxTokens,
      (text, tokens) =>
        send({
          type: 'progress',
          id: command.id,
          phase: 'recognizing',
          detail: `${tokens} tokens`,
          fraction: null,
          text,
        }),
    );
    send({
      type: 'result',
      id: command.id,
      result: {
        id: command.id,
        name: command.name,
        image: command.image,
        original: result.text,
        edited: result.text,
        createdAt: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        firstTokenMs: result.firstTokenAt === null ? null : result.firstTokenAt - started,
        tokenCount: result.tokenCount,
        truncated: result.tokenCount >= command.maxTokens,
        gpu: gpuDescription,
        modelRevision: manifest.revision,
        mode: command.task,
        ...(command.task === 'auto' ? {} : { task: command.task }),
      },
    });
  } catch (error) {
    send({
      type: 'failed',
      id: command.id,
      message: error instanceof Error ? error.message.slice(0, 1800) : 'Local recognition failed',
    });
  } finally {
    working = false;
  }
};
