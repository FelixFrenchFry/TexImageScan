import { z } from 'zod';

export const PORT_NAME = 'teximagescan-panel';
export const MAX_IMAGE_BYTES = 12_000_000;
export const MAX_HISTORY_PREVIEW_LENGTH = 4096;
// keep legacy modes for stored scans
const legacyRecognitionModeSchema = z.enum(['auto', 'equation', 'mixed']);
export const imageSchema = z
  .string()
  .max(16_000_100)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/);
export const inputSchema = z.object({
  id: z.string(),
  image: imageSchema,
  name: z.string().max(200),
});
export const captureEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('capture-started'), id: z.string() }),
  z.object({
    type: z.literal('capture-finished'),
    id: z.string(),
    image: imageSchema,
    name: z.string().max(200),
  }),
  z.object({ type: z.literal('capture-cancelled'), id: z.string() }),
  z.object({ type: z.literal('capture-failed'), id: z.string(), message: z.string().max(1800) }),
]);
export type CaptureEvent = z.infer<typeof captureEventSchema>;
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prepare') }),
  z.object({ type: z.literal('set-input'), image: imageSchema, name: z.string().max(200) }),
  z.object({
    type: z.literal('recognize'),
    image: imageSchema,
    name: z.string().max(200),
    maxTokens: z.number().int().min(32).max(4096),
  }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('save'), id: z.string(), text: z.string().max(100_000) }),
  z.object({ type: z.literal('clear'), discard: z.literal(true).optional() }),
  z.object({ type: z.literal('retry-save') }),
  z.object({ type: z.literal('open-scan'), id: z.string() }),
  z.object({ type: z.literal('delete-scans'), ids: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('clear-history') }),
  z.object({
    type: z.literal('read-result'),
    id: z.string(),
    resultId: z.string(),
  }),
  z.object({ type: z.literal('remove-model') }),
]);
export type PanelCommand = z.infer<typeof commandSchema>;

export const resultSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: imageSchema,
  original: z.string(),
  raw: z.string().optional(),
  edited: z.string(),
  createdAt: z.string(),
  elapsedMs: z.number(),
  firstTokenMs: z.number().nullable(),
  tokenCount: z.number().int(),
  truncated: z.boolean(),
  gpu: z.string(),
  modelRevision: z.string(),
  // retain metadata from older scans
  task: z.enum(['equation', 'mixed']).optional(),
  mode: legacyRecognitionModeSchema.optional(),
});
export type RecognitionResult = z.infer<typeof resultSchema>;
export const scanMetadataSchema = resultSchema.omit({ image: true });
export const historyEntrySchema = resultSchema
  .pick({ id: true, name: true, createdAt: true, truncated: true })
  .extend({ preview: z.string().max(MAX_HISTORY_PREVIEW_LENGTH), edited: z.boolean() });
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export const resultTextReplySchema = z.object({
  type: z.literal('result-text'),
  id: z.string(),
  outcome: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), text: z.string() }),
    z.object({ ok: z.literal(false), message: z.string() }),
  ]),
});
export type ResultTextReply = z.infer<typeof resultTextReplySchema>;
const phaseSchema = z.enum(['downloading', 'loading', 'recognizing']);
export const stateSchema = z.object({
  model: z.enum(['missing', 'cached', 'ready']),
  gpu: z.string().nullable(),
  job: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('idle') }),
    z.object({
      kind: z.literal('running'),
      id: z.string(),
      phase: phaseSchema,
      detail: z.string(),
      fraction: z.number().nullable(),
      text: z.string(),
    }),
    z.object({ kind: z.literal('failed'), message: z.string() }),
    z.object({ kind: z.literal('cancelled') }),
    z.object({ kind: z.literal('interrupted') }),
  ]),
  result: resultSchema.nullable(),
  saveError: z.string().nullable().default(null),
  history: z.array(historyEntrySchema).default([]),
  input: inputSchema.nullable().default(null),
  capture: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('idle') }),
      z.object({ kind: z.literal('selecting'), id: z.string() }),
      z.object({ kind: z.literal('failed'), message: z.string() }),
    ])
    .default({ kind: 'idle' }),
});
export type AppState = z.infer<typeof stateSchema>;
export const workerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('device-lost'), message: z.string() }),
  z.object({
    type: z.literal('progress'),
    id: z.string(),
    phase: phaseSchema,
    detail: z.string(),
    fraction: z.number().nullable(),
    text: z.string(),
  }),
  z.object({ type: z.literal('ready'), id: z.string(), gpu: z.string(), loadMs: z.number() }),
  z.object({ type: z.literal('result'), id: z.string(), result: resultSchema }),
  z.object({ type: z.literal('failed'), id: z.string(), message: z.string() }),
]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export const workerCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prepare'), id: z.string() }),
  z.object({
    type: z.literal('recognize'),
    id: z.string(),
    image: imageSchema,
    name: z.string().max(200),
    maxTokens: z.number().int().min(32).max(4096),
  }),
]);
export type WorkerCommand = z.infer<typeof workerCommandSchema>;
