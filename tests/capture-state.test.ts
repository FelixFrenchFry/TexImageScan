import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { initialState, reduceCaptureEvent, recoverState } from '../src/state';
import { loadState, saveWorkspace } from '../src/storage';
import { stateSchema, type AppState } from '../src/protocol';

const input = { id: 'crop', name: 'Page crop', image: 'data:image/png;base64,AAAA' };

const completedJobs = [
  { kind: 'failed', message: 'Previous recognition failed.' },
  { kind: 'cancelled' },
  { kind: 'interrupted' },
] satisfies AppState['job'][];

it.each(completedJobs)('a new capture clears the obsolete $kind job and preserves save errors', (job) => {
  const state = { ...initialState(), input, job, saveError: 'Unsaved edits' };
  const selecting = reduceCaptureEvent(state, { type: 'capture-started', id: 'new' });
  const cancelled = reduceCaptureEvent(selecting, { type: 'capture-cancelled', id: 'new' });
  expect(cancelled.job).toEqual(job);
  const completed = reduceCaptureEvent(selecting, {
    type: 'capture-finished', id: 'new', name: 'new crop', image: input.image,
  });
  expect(completed.job).toEqual({ kind: 'idle' });
  expect(completed.saveError).toBe('Unsaved edits');
});

it('retains a selected source without starting recognition and ignores stale completions', () => {
  const state = { ...initialState(), input };
  const selecting = reduceCaptureEvent(state, { type: 'capture-started', id: 'new' });
  expect(
    reduceCaptureEvent(selecting, {
      type: 'capture-finished',
      id: 'old',
      name: 'wrong',
      image: input.image,
    }),
  ).toEqual(selecting);
  const completed = reduceCaptureEvent(selecting, {
    type: 'capture-finished',
    id: 'new',
    name: 'new crop',
    image: input.image,
  });
  expect(completed.input?.name).toBe('new crop');
  expect(completed.capture.kind).toBe('idle');
  expect(completed.job.kind).toBe('idle');
});

it('cancellation and failure preserve the previous input and result', () => {
  const selecting = reduceCaptureEvent(
    { ...initialState(), input },
    { type: 'capture-started', id: 'new' },
  );
  for (const event of [
    { type: 'capture-cancelled', id: 'new' },
    { type: 'capture-failed', id: 'new', message: 'blocked' },
  ] as const) {
    const next = reduceCaptureEvent(selecting, event);
    expect(next.input).toEqual(input);
    expect(next.result).toEqual(selecting.result);
  }
});

it('persists a source crop across host restart and recovers interrupted selection', async () => {
  await saveWorkspace({ ...initialState(), input, capture: { kind: 'selecting', id: 'new' } });
  const restored = await loadState();
  expect(restored.input).toEqual(input);
  expect(restored.capture.kind).toBe('failed');
});

it('loads old saved state with no capture fields', () => {
  const old = { model: 'missing', gpu: null, job: { kind: 'idle' }, result: null };
  expect(recoverState(stateSchema.parse(old))).toMatchObject({
    input: null,
    capture: { kind: 'idle' },
  });
});
