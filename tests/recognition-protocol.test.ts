import { expect, it } from 'vitest';
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
it('strips obsolete mode requests at both live boundaries', () => {
  for (const task of [undefined, 'auto', 'mixed', 'equation']) {
    expect(commandSchema.parse({ ...crop, task })).not.toHaveProperty('task');
    expect(workerCommandSchema.parse({ ...crop, task, id: 'job' })).not.toHaveProperty('task');
  }
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
