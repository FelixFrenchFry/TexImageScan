import { type AppState, type WorkerEvent, type CaptureEvent } from './protocol';

export function initialState(): AppState {
  return {
    model: 'missing',
    gpu: null,
    job: { kind: 'idle' },
    result: null,
    saveError: null,
    input: null,
    capture: { kind: 'idle' },
    history: [],
  };
}

export function recoverState(state: AppState): AppState {
  return {
    ...state,
    model: state.model === 'ready' ? 'cached' : state.model,
    job: state.job.kind === 'running' ? { kind: 'interrupted' } : state.job,
    input:
      state.input ??
      (state.result
        ? { id: state.result.id, name: state.result.name, image: state.result.image }
        : null),
    capture:
      state.capture.kind === 'selecting'
        ? {
            kind: 'failed',
            message: 'The previous capture was interrupted. Capture the area again.',
          }
        : state.capture,
  };
}

export function reduceCaptureEvent(state: AppState, event: CaptureEvent): AppState {
  if (event.type === 'capture-started') {
    if (state.job.kind === 'running') return state;
    return { ...state, capture: { kind: 'selecting', id: event.id } };
  }
  if (state.capture.kind !== 'selecting' || state.capture.id !== event.id) return state;
  switch (event.type) {
    case 'capture-finished':
      return {
        ...state,
        capture: { kind: 'idle' },
        input: { id: event.id, name: event.name, image: event.image },
        job: { kind: 'idle' },
      };
    case 'capture-cancelled':
      return { ...state, capture: { kind: 'idle' } };
    case 'capture-failed':
      return { ...state, capture: { kind: 'failed', message: event.message } };
  }
}

export function reduceWorkerEvent(state: AppState, event: WorkerEvent): AppState {
  if (event.type === 'device-lost')
    return {
      ...state,
      model: state.model === 'missing' ? 'missing' : 'cached',
      job: { kind: 'failed', message: event.message },
    };
  // only the current job can publish a result
  if (state.job.kind !== 'running' || state.job.id !== event.id) return state;
  switch (event.type) {
    case 'progress':
      return { ...state, job: { ...state.job, ...event, kind: 'running' } };
    case 'ready':
      return { ...state, model: 'ready', gpu: event.gpu, job: { kind: 'idle' } };
    case 'result':
      return {
        ...state,
        model: 'ready',
        gpu: event.result.gpu,
        result: event.result,
        // a completed scan owns its input while later uploads get their own IDs
        input: { id: event.result.id, name: event.result.name, image: event.result.image },
        job: { kind: 'idle' },
      };
    case 'failed':
      return {
        ...state,
        model: state.model === 'ready' ? 'cached' : state.model,
        job: { kind: 'failed', message: event.message },
      };
  }
}
