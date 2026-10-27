import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { loadState, saveScan } from '../src/storage';
import { initialState, reduceWorkerEvent } from '../src/state';
import { requireGpu } from '../src/gpu';
import { type RecognitionResult } from '../src/protocol';

const result: RecognitionResult = {
  id: 'completed',
  name: 'equation.png',
  image: 'data:image/png;base64,AAAA',
  original: '$x=1$',
  edited: '$x=2$',
  createdAt: '2026-10-23T00:00:00Z',
  elapsedMs: 100,
  firstTokenMs: 50,
  tokenCount: 5,
  truncated: false,
  gpu: 'test adapter',
  modelRevision: 'pinned',
};

describe('retained results', () => {
  it('restores edits and recovers an interrupted replacement', async () => {
    await saveScan({
      ...initialState(),
      model: 'ready',
      result,
      job: {
        kind: 'running',
        id: 'replacement',
        phase: 'recognizing',
        detail: '',
        fraction: null,
        text: 'provisional',
      },
    });
    const restored = await loadState();
    expect(restored.result?.edited).toBe('$x=2$');
    expect(restored.job.kind).toBe('interrupted');
    expect(restored.model).toBe('cached');
  });

  it('does not replace a completed result when the new job fails', () => {
    const state = {
      ...initialState(),
      result,
      input: { id: 'pending', name: result.name, image: result.image },
      job: {
        kind: 'running' as const,
        id: 'new',
        phase: 'recognizing' as const,
        detail: '',
        fraction: null,
        text: '',
      },
    };
    const failed = reduceWorkerEvent(state, { type: 'failed', id: 'new', message: 'GPU lost' });
    expect(failed.result).toEqual(result);
    expect(failed.input).toEqual(state.input);
    expect(failed.job.kind).toBe('failed');
    expect(
      reduceWorkerEvent(failed, {
        type: 'result',
        id: 'new',
        result: { ...result, original: 'late' },
      }),
    ).toEqual(failed);
  });

  it('accepts only the active job completion and preserves truncation metadata', () => {
    const state = {
      ...initialState(),
      result,
      input: { id: 'pending', name: result.name, image: result.image },
      job: {
        kind: 'running' as const,
        id: 'new',
        phase: 'recognizing' as const,
        detail: '',
        fraction: null,
        text: '',
      },
    };
    expect(reduceWorkerEvent(state, { type: 'result', id: 'old', result })).toEqual(state);
    const completed = reduceWorkerEvent(state, {
      type: 'result',
      id: 'new',
      result: { ...result, id: 'new', truncated: true },
    });
    expect(completed.result?.truncated).toBe(true);
    expect(completed.result?.id).toBe('new');
    expect(completed.input).toEqual({
      id: 'new',
      name: 'equation.png',
      image: 'data:image/png;base64,AAAA',
    });
  });
});

describe('GPU availability', () => {
  it('explains unsupported devices without attempting a download or server fallback', async () => {
    await expect(requireGpu(undefined, {})).rejects.toThrow('WebGPU is unavailable');
  });
});
