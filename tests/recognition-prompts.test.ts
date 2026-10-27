import { expect, it } from 'vitest';
import { recognitionInstructions } from '../src/recognition-prompts';
import {
  commandSchema,
  workerCommandSchema,
  workerEventSchema,
  resultSchema,
} from '../src/protocol';
const crop = {
  type: 'recognize',
  image: 'data:image/png;base64,AAAA',
  name: 'crop.png',
  maxTokens: 1024,
};
it('uses the universal prompt for Auto and keeps native manual instructions', () => {
  expect(recognitionInstructions.auto).toBe(
    'Transcribe the image in reading order. Preserve normal text and spaces. Write mathematical expressions in LaTeX, using $...$ for inline math and $$...$$ for standalone equations. Output only the transcription.',
  );
  expect(recognitionInstructions.equation).toBe(
    'Please write out the expression of the formula in the image using LaTeX format.',
  );
  expect(recognitionInstructions.mixed).toBe('Please output the text content from the image.');
});
it('defaults both command boundaries to single-pass Auto', () => {
  expect(commandSchema.parse(crop)).toMatchObject({ task: 'auto' });
  expect(workerCommandSchema.parse({ ...crop, id: 'job' })).toMatchObject({ task: 'auto' });
});
it('rejects retired classification progress at the live worker boundary', () => {
  expect(
    workerEventSchema.safeParse({
      type: 'progress',
      id: 'job',
      phase: 'classifying',
      detail: 'layout',
      fraction: null,
      text: '',
    }).success,
  ).toBe(false);
});
it('reads old scan content and mode while stripping obsolete routing metadata', () => {
  const scan = {
    id: 'old',
    name: 'old.png',
    image: crop.image,
    original: '$x=1$',
    edited: '$x=2$',
    createdAt: '2026-10-24',
    elapsedMs: 1,
    firstTokenMs: 1,
    tokenCount: 1,
    truncated: false,
    gpu: 'test',
    modelRevision: 'test',
    mode: 'auto',
    task: 'equation',
    routing: { reason: 'equation', raw: 'layout', elapsedMs: 1, tokenCount: 1 },
  };
  const parsed = resultSchema.parse(scan);
  expect(parsed.edited).toBe('$x=2$');
  expect(parsed.mode).toBe('auto');
  expect(parsed).not.toHaveProperty('routing');
});
