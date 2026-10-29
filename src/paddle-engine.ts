import { z } from 'zod';

const resultSchema = z.object({
  text: z.string(),
  visionTokens: z.number().int().positive().optional(),
  promptTokens: z.number().int().positive().optional(),
  generationMs: z.number().nonnegative().optional(),
  tokensPerSecond: z.number().nonnegative().optional(),
  decoderResidentWeightBytes: z.number().int().nonnegative().optional(),
  greedy: z.object({
    tokenIds: z.array(z.number().int().nonnegative()),
    stopReason: z.enum(['eos', 'max_steps', 'capacity_exhausted']),
  }),
});
export type PaddleResult = z.infer<typeof resultSchema>;
export const paddleOptionsSchema = z.object({
  task: z.enum(['formula', 'ocr']),
  maxGeneratedTokens: z.number().int().min(1).max(4096),
  preprocessing: z.object({
    minPixels: z.number().int().min(784).max(1_003_520).default(112_896),
    maxPixels: z.number().int().min(1_003_520).max(2_007_040).default(1_003_520),
  }).refine((value) => value.minPixels <= value.maxPixels, 'Minimum pixel budget must not exceed maximum').optional(),
  promptSuffixIds: z.array(z.number().int().min(0).max(103423)).min(1).max(512).optional(),
});
export type PaddleOptions = z.input<typeof paddleOptionsSchema> & {
  onProgress?: (update: unknown) => void;
  onToken?: (text: string, tokenCount: number) => void;
};
export type PaddleEngine = {
  recognizeCanvas: (canvas: OffscreenCanvas, options: PaddleOptions) => Promise<PaddleResult>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export async function createPaddleEngine(options: {
  fetchAsset: (url: string) => Promise<Response>;
  onDeviceLost: (info: unknown) => void;
}): Promise<PaddleEngine> {
  // load executable code from the extension and model data from the verified cache
  const url = new URL('/paddle/browser_ocr_runtime.mjs', self.location.href).href;
  const module: unknown = await import(/* @vite-ignore */ url);
  if (!record(module) || typeof module.createPaddleOcrVlEngine !== 'function')
    throw new Error('The bundled Paddle runtime is unavailable');
  const instance: unknown = await module.createPaddleOcrVlEngine(options);
  if (!record(instance) || typeof instance.recognizeCanvas !== 'function')
    throw new Error('The bundled Paddle runtime has no recognition interface');
  const recognize = instance.recognizeCanvas.bind(instance);
  return {
    async recognizeCanvas(canvas, request) {
      const { onProgress, onToken, ...input } = request;
      const configuration = paddleOptionsSchema.parse(input);
      return resultSchema.parse(await recognize(canvas, { ...configuration, onProgress, onToken }));
    },
  };
}

export function normalizePaddleOutput(text: string, task: 'formula' | 'ocr'): string {
  const trimmed = text.trim();
  if (!trimmed || task !== 'formula') return trimmed;
  if (/^(?:\$\$|\$|\\\[|\\\(|```)/.test(trimmed)) return trimmed;
  return `\\[${trimmed}\\]`;
}

export function paddleTokenCount(result: PaddleResult): number {
  return result.greedy.tokenIds.length - (result.greedy.tokenIds.at(-1) === 2 ? 1 : 0);
}
