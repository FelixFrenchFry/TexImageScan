import { describe, expect, it } from 'vitest';
import { initialState, reduceWorkerEvent, recoverState } from '../src/state';
import { commandSchema } from '../src/protocol';

describe('recognition lifetime', () => {
  it('ignores a late completion after cancellation', () => {
    const cancelled = { ...initialState(), job: { kind: 'cancelled' as const } };
    expect(
      reduceWorkerEvent(cancelled, {
        type: 'progress',
        id: 'old',
        phase: 'recognizing',
        detail: 'Late',
        fraction: null,
        text: 'wrong',
      }),
    ).toEqual(cancelled);
  });

  it('recovers interrupted work without deleting a completed result', () => {
    const state = initialState();
    state.job = {
      kind: 'running',
      id: 'job',
      phase: 'loading',
      detail: '',
      fraction: null,
      text: '',
    };
    const recovered = recoverState(state);
    expect(recovered.job.kind).toBe('interrupted');
    expect(recovered.result).toEqual(state.result);
    expect(recovered.model).toBe('missing');
  });

  it('rejects unsupported image types, oversized input, and invalid token limits', () => {
    const message = {
      type: 'recognize',
      image: 'data:image/svg+xml;base64,AAAA',
      name: 'unsafe.svg',
      maxTokens: 1024,
    };
    expect(commandSchema.safeParse(message).success).toBe(false);
    expect(
      commandSchema.safeParse({ ...message, image: 'data:image/png;base64,AAAA', maxTokens: 0 })
        .success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ type: 'save', id: 'x', text: 'x'.repeat(100_001) }).success,
    ).toBe(false);
  });

  it('invalidates ready sessions when the GPU is lost while idle', () => {
    const state = { ...initialState(), model: 'ready' as const };
    const lost = reduceWorkerEvent(state, { type: 'device-lost', message: 'GPU device lost' });
    expect(lost.model).toBe('cached');
    expect(lost.job).toEqual({ kind: 'failed', message: 'GPU device lost' });
    expect(lost.result).toEqual(state.result);
  });
});
