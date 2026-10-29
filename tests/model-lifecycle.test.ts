import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import manifest from '../src/model-manifest.json';
import {
  PORT_NAME,
  resultTextReplySchema,
  stateSchema,
  type AppState,
  type CaptureEvent,
  type PanelCommand,
  type RecognitionResult,
  type ResultTextReply,
  type WorkerCommand,
  type WorkerEvent,
} from '../src/protocol';
import { loadState, saveScan } from '../src/storage';

// replace Chrome transport and the GPU worker
// keep the host queue, reducer, cache checks and storage unchanged
const transport = vi.hoisted(() => ({
  connect: (_port: PanelPort) => {},
  message: (_message: unknown, _sender: unknown, _respond: (reply: unknown) => void) => {},
}));
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'lifecycle-test',
      getURL: (path: string) => 'chrome-extension://lifecycle-test' + path,
      onMessage: {
        addListener: (listener: typeof transport.message) => {
          transport.message = listener;
        },
      },
      onConnect: {
        addListener: (listener: (port: PanelPort) => void) => {
          transport.connect = listener;
        },
      },
    },
  },
}));

class PanelPort {
  name = PORT_NAME;
  sender = { id: 'lifecycle-test', url: 'chrome-extension://lifecycle-test/sidepanel.html' };
  states: AppState[] = [];
  texts: string[] = [];
  replies: ResultTextReply[] = [];
  private listeners: ((state: AppState) => void)[] = [];
  private command: (command: PanelCommand) => void = () => {};
  private disconnectListener: () => void = () => {};
  onMessage = {
    addListener: (listener: (command: PanelCommand) => void) => {
      this.command = listener;
    },
  };
  onDisconnect = {
    addListener: (listener: () => void) => {
      this.disconnectListener = listener;
    },
  };
  postMessage(message: unknown) {
    const reply = resultTextReplySchema.safeParse(message);
    if (reply.success) {
      this.replies.push(reply.data);
      if (reply.data.outcome.ok) this.texts.push(reply.data.outcome.text);
      return;
    }
    const state = stateSchema.parse(message);
    this.states.push(structuredClone(state));
    for (const listener of this.listeners) listener(state);
  }
  send(command: PanelCommand) {
    this.command(command);
  }
  disconnect() {
    this.disconnectListener();
  }
  stateWhen(predicate: (state: AppState) => boolean): Promise<AppState> {
    const latest = this.states.at(-1);
    if (latest && predicate(latest)) return Promise.resolve(latest);
    return new Promise((resolve) =>
      this.listeners.push((state) => {
        if (predicate(state)) resolve(structuredClone(state));
      }),
    );
  }
}

class GpuWorker {
  static instances: GpuWorker[] = [];
  onmessage: ((message: { data: WorkerEvent }) => void) | null = null;
  onerror = null;
  requests: WorkerCommand[] = [];
  terminated = false;
  constructor() {
    GpuWorker.instances.push(this);
  }
  postMessage(command: WorkerCommand) {
    this.requests.push(command);
  }
  terminate() {
    this.terminated = true;
  }
  complete() {
    const request = this.requests.at(-1);
    if (!request || request.type !== 'recognize') throw new Error('Expected recognition');
    const result: RecognitionResult = {
      id: request.id,
      name: request.name,
      image: request.image,
      original: '$x=1$',
      edited: '$x=1$',
      createdAt: new Date().toISOString(),
      elapsedMs: 100,
      firstTokenMs: 50,
      tokenCount: 5,
      truncated: false,
      gpu: 'test GPU',
      modelRevision: manifest.revision,
      mode: 'equation',
    };
    this.onmessage?.({ data: { type: 'result', id: request.id, result } });
  }
}
let cachePresent = true;
let cacheUnavailable = false;
const recognize: PanelCommand = {
  type: 'recognize',
  image: 'data:image/png;base64,AAAA',
  name: 'crop.png',
  maxTokens: 1024,
};

beforeEach(async () => {
  vi.resetModules();
  await deleteDB('teximagescan-prototype');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  GpuWorker.instances = [];
  cachePresent = true;
  cacheUnavailable = false;
  vi.stubGlobal('Worker', GpuWorker);
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (key: string) => {
        if (cacheUnavailable) throw new Error('Cache storage unavailable');
        if (!cachePresent) return undefined;
        if (key.endsWith('__verified__')) return new Response(manifest.revision);
        const file = manifest.files.find((file) => key.endsWith('/' + file.path));
        return file
          ? new Response('', { headers: { 'content-length': String(file.size) } })
          : undefined;
      },
    }),
  });
  await import('../entrypoints/offscreen/main');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function panel() {
  const port = new PanelPort();
  transport.connect(port);
  await port.stateWhen((state) => state.model === 'cached' || state.model === 'ready');
  return port;
}
async function complete(port: PanelPort, worker: GpuWorker) {
  const previous = port.states.at(-1)?.result?.id;
  worker.complete();
  return port.stateWhen((state) => state.job.kind === 'idle' && state.result?.id !== previous);
}

it('reuses GPU sessions, releases after five idle minutes, and reloads on the next recognition', async () => {
  const port = await panel();
  port.send(recognize);
  await port.stateWhen((state) => state.job.kind === 'running');
  // broadcast the running state before posting to the worker
  await Promise.resolve();
  const worker = GpuWorker.instances[0];
  if (!worker) throw new Error('Recognition did not create a GPU worker');
  await complete(port, worker);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(worker.terminated).toBe(false);
  port.send(recognize);
  await port.stateWhen((state) => state.job.kind === 'running');
  await Promise.resolve();
  expect(GpuWorker.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(worker.terminated).toBe(false);
  await complete(port, worker);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(port.states.at(-1)?.model).toBe('ready');
  await vi.advanceTimersByTimeAsync(1);
  expect(worker.terminated).toBe(true);
  expect(port.states.at(-1)?.model).toBe('cached');
  expect(port.states.at(-1)?.result?.original).toBe('$x=1$');
  port.send(recognize);
  await port.stateWhen((state) => state.job.kind === 'running');
  await Promise.resolve();
  expect(GpuWorker.instances).toHaveLength(2);
  const fresh = GpuWorker.instances[1];
  if (!fresh) throw new Error('Recognition did not recreate the released worker');
  worker.complete();
  await Promise.resolve();
  expect(port.states.at(-1)?.job.kind).toBe('running');
  await complete(port, fresh);
  expect(port.states.at(-1)?.model).toBe('ready');
});

it('finishes and persists recognition after every panel closes, then releases on the idle timeout', async () => {
  const first = await panel(),
    second = await panel();
  first.send(recognize);
  await first.stateWhen((state) => state.job.kind === 'running');
  await Promise.resolve();
  const worker = GpuWorker.instances[0];
  if (!worker) throw new Error('Recognition did not create a GPU worker');
  first.disconnect();
  second.disconnect();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(worker.terminated).toBe(false);
  const observer = await panel();
  observer.disconnect();
  worker.complete();
  // receive completion through the host command queue
  const reopened = await panel();
  const result = await reopened.stateWhen((state) => state.job.kind === 'idle' && !!state.result);
  expect(result.result?.original).toBe('$x=1$');
  expect((await loadState()).result?.id).toBe(result.result?.id);
  reopened.disconnect();
  await vi.advanceTimersByTimeAsync(299_999);
  expect(worker.terminated).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(worker.terminated).toBe(true);
  const later = await panel();
  expect(later.states.at(-1)?.model).toBe('cached');
  expect(later.states.at(-1)?.result?.id).toBe(result.result?.id);
});

it.each(['prepare', 'recognize'])(
  'starts %s even when its workspace checkpoint fails',
  async (type) => {
    const port = await panel();
    port.send(recognize);
    await port.stateWhen((state) => state.job.kind === 'running');
    await Promise.resolve();
    const worker = GpuWorker.instances[0];
    if (!worker) throw new Error('Recognition did not create a GPU worker');
    const completed = await complete(port, worker);
    await vi.advanceTimersByTimeAsync(299_999);
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('Disk full', 'QuotaExceededError');
    });
    port.send(type === 'prepare' ? { type: 'prepare' } : recognize);
    await port.stateWhen((state) => state.job.kind === 'running');
    await port.stateWhen((state) => !!state.saveError);
    expect(worker.requests).toHaveLength(2);
    expect(port.states.at(-1)?.job.kind).toBe('running');
    expect(port.states.at(-1)?.saveError).toBeTruthy();
    expect(port.states.at(-1)?.result).toEqual(completed.result);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.terminated).toBe(false);
    port.send({ type: 'cancel' });
    await port.stateWhen((state) => state.job.kind === 'cancelled');
    expect(worker.terminated).toBe(true);
  },
);

it('releases prepared GPU sessions even when the workspace cannot be saved', async () => {
  const port = await panel();
  port.send({ type: 'prepare' });
  const running = await port.stateWhen((state) => state.job.kind === 'running');
  if (running.job.kind !== 'running') throw new Error('Expected a running job');
  await Promise.resolve();
  const worker = GpuWorker.instances[0];
  if (!worker) throw new Error('Preparation did not create a GPU worker');
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
    throw new DOMException('Disk full', 'QuotaExceededError');
  });
  worker.onmessage?.({
    data: { type: 'ready', id: running.job.id, gpu: 'test GPU', loadMs: 1 },
  });
  await port.stateWhen((state) => !!state.saveError);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(worker.terminated).toBe(true);
  expect(port.states.at(-1)?.model).toBe('cached');
  expect(port.states.at(-1)?.saveError).toBeTruthy();
});

it.each([
  { intact: false, unavailable: false, expected: 'missing' },
  { intact: true, unavailable: false, expected: 'cached' },
  { intact: true, unavailable: true, expected: 'missing' },
])(
  'failed recognition with intact=$intact unavailable=$unavailable reports $expected and remains retryable',
  async ({ intact, unavailable, expected }) => {
    const port = await panel();
    port.send(recognize);
    const running = await port.stateWhen((state) => state.job.kind === 'running');
    if (running.job.kind !== 'running') throw new Error('Expected a running job');
    await Promise.resolve();
    const worker = GpuWorker.instances[0];
    if (!worker) throw new Error('Recognition did not create a GPU worker');
    cachePresent = intact;
    cacheUnavailable = unavailable;
    worker.onmessage?.({
      data: { type: 'failed', id: running.job.id, message: 'Recognition could not load the model' },
    });
    const failed = await port.stateWhen((state) => state.job.kind === 'failed');
    expect(failed.model).toBe(expected);
    expect(failed.job).toEqual({ kind: 'failed', message: 'Recognition could not load the model' });
    expect(worker.terminated).toBe(true);
  },
);

it('keeps unsaved edits authoritative for copying and navigation until storage recovers', async () => {
  const port = await panel();
  port.send(recognize);
  await port.stateWhen((state) => state.job.kind === 'running');
  await Promise.resolve();
  const worker = GpuWorker.instances[0];
  if (!worker) throw new Error('Recognition did not create a GPU worker');
  const completed = await complete(port, worker);
  const result = completed.result;
  if (!result) throw new Error('Recognition did not complete');
  await saveScan({
    ...completed,
    result: {
      ...result,
      id: 'another',
      name: 'another.png',
      createdAt: new Date(Date.parse(result.createdAt) + 1000).toISOString(),
    },
  });

  const put = IDBObjectStore.prototype.put;
  const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (this.name === 'scans') throw new DOMException('Disk full', 'QuotaExceededError');
    return put.call(this, value, key);
  });
  port.send({ type: 'save', id: result.id, text: '$x=corrected$' });
  await vi.waitFor(() => expect(port.states.at(-1)?.result?.edited).toBe('$x=corrected$'));
  expect(port.states.at(-1)?.saveError).toBeTruthy();
  expect(port.states.at(-1)?.job.kind).toBe('idle');
  expect((await loadState()).result?.edited).toBe('$x=1$');

  port.send({ type: 'read-result', id: 'copy', resultId: result.id });
  await vi.waitFor(() => expect(port.texts).toEqual(['$x=corrected$']));
  port.send({ type: 'open-scan', id: result.id });
  port.send({ type: 'open-scan', id: 'another' });
  port.send({ type: 'clear' });
  port.send(recognize);
  port.send({ type: 'read-result', id: 'after-navigation', resultId: result.id });
  await vi.waitFor(() => expect(port.texts).toHaveLength(2));
  expect(port.states.at(-1)?.result).toMatchObject({ id: result.id, edited: '$x=corrected$' });
  expect(port.states.at(-1)?.saveError).toBeTruthy();
  expect(worker.requests).toHaveLength(1);

  fail.mockRestore();
  port.send({ type: 'set-input', image: 'data:image/png;base64,BBBB', name: 'next.png' });
  await port.stateWhen((state) => state.input?.name === 'next.png');
  expect(port.states.at(-1)?.saveError).toBeTruthy();
  expect((await loadState()).result?.edited).toBe('$x=1$');
  port.send({ type: 'retry-save' });
  await vi.waitFor(() => expect(port.states.at(-1)?.saveError).toBeNull());
  const restored = await loadState();
  expect(restored.result?.edited).toBe('$x=corrected$');
  expect(restored.saveError).toBeNull();
  port.send({ type: 'open-scan', id: 'another' });
  await port.stateWhen((state) => state.result?.id === 'another');
});

it('lets a new unsaved result be copied after GPU release and explicitly discarded', async () => {
  const port = await panel();
  port.send(recognize);
  await port.stateWhen((state) => state.job.kind === 'running');
  await Promise.resolve();
  const worker = GpuWorker.instances[0];
  if (!worker) throw new Error('Recognition did not create a GPU worker');
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (this.name === 'scans') throw new DOMException('Disk full', 'QuotaExceededError');
    return put.call(this, value, key);
  });
  worker.complete();
  await port.stateWhen((state) => !!state.saveError);
  const result = port.states.at(-1)?.result;
  if (!result) throw new Error('Unsaved result was lost');
  expect((await loadState()).history).toEqual([]);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(worker.terminated).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(worker.terminated).toBe(true);
  expect(port.states.at(-1)?.result).toEqual(result);
  expect(port.states.at(-1)?.saveError).toBeTruthy();
  const unavailable = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  port.send({ type: 'read-result', id: 'copy-new', resultId: result.id });
  await vi.waitFor(() => expect(port.texts).toEqual(['$x=1$']));
  port.send({ type: 'read-result', id: 'stale', resultId: 'different-result' });
  await vi.waitFor(() => expect(port.replies.at(-1)).toMatchObject({
    id: 'stale', outcome: { ok: false, message: expect.stringContaining('no longer active') },
  }));
  expect(port.states.at(-1)?.job.kind).toBe('idle');
  expect(port.states.at(-1)?.saveError).toBeTruthy();
  expect(unavailable).not.toHaveBeenCalled();
  unavailable.mockRestore();
  port.send({ type: 'clear', discard: true });
  await vi.waitFor(() => expect(port.states.at(-1)?.result).toBeNull());
  expect(port.states.at(-1)?.saveError).toBeNull();
  port.send({ type: 'read-result', id: 'discarded', resultId: result.id });
  await vi.waitFor(() => expect(port.replies.at(-1)).toMatchObject({
    id: 'discarded', outcome: { ok: false },
  }));
  expect(port.texts).toEqual(['$x=1$']);
});

function capture(event: CaptureEvent): Promise<unknown> {
  return new Promise((resolve) => transport.message(
    { type: 'capture-host', event },
    { id: 'lifecycle-test', url: 'chrome-extension://lifecycle-test/background.js' },
    resolve,
  ));
}

it('acknowledges a repeated completion without replacing a newer capture or upload', async () => {
  const port = await panel();
  const event: CaptureEvent = {
    type: 'capture-finished', id: 'crop', image: recognize.image, name: 'Page crop',
  };
  expect(await capture({ type: 'capture-started', id: event.id })).toEqual({ ok: true });
  expect(await capture(event)).toEqual({ ok: true });
  expect(await capture(event)).toEqual({ ok: true });
  expect(await capture({ type: 'capture-cancelled', id: event.id })).toEqual({ ok: true });
  expect(port.states.at(-1)?.input?.id).toBe(event.id);
  expect(await capture({ type: 'capture-started', id: 'new-crop' })).toEqual({ ok: true });
  expect(await capture(event)).toEqual({ ok: true });
  expect(port.states.at(-1)?.capture).toEqual({ kind: 'selecting', id: 'new-crop' });
  expect(await capture({ type: 'capture-cancelled', id: 'new-crop' })).toEqual({ ok: true });
  port.send({ type: 'set-input', image: 'data:image/png;base64,CCCC', name: 'New upload' });
  await port.stateWhen((state) => state.input?.name === 'New upload');
  expect(await capture(event)).toMatchObject({ ok: false });
  expect(port.states.at(-1)?.input?.name).toBe('New upload');
});

it('acknowledges repeated cancellation and failure without cancelling a newer capture', async () => {
  const port = await panel();
  for (const event of [
    { type: 'capture-cancelled', id: 'cancelled' },
    { type: 'capture-failed', id: 'failed', message: 'Capture interrupted' },
  ] satisfies CaptureEvent[]) {
    expect(await capture({ type: 'capture-started', id: event.id })).toEqual({ ok: true });
    expect(await capture(event)).toEqual({ ok: true });
    expect(await capture(event)).toEqual({ ok: true });
    expect(await capture({ type: 'capture-started', id: 'new' })).toEqual({ ok: true });
    expect(await capture(event)).toMatchObject({ ok: false });
    expect(port.states.at(-1)?.capture).toEqual({ kind: 'selecting', id: 'new' });
    expect(await capture({ type: 'capture-cancelled', id: 'new' })).toEqual({ ok: true });
  }
});

it('accepts capture lifecycle events when workspace storage is full', async () => {
  const port = await panel();
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
    throw new DOMException('Disk full', 'QuotaExceededError');
  });
  expect(await capture({ type: 'capture-started', id: 'crop' })).toEqual({ ok: true });
  expect(port.states.at(-1)?.capture).toEqual({ kind: 'selecting', id: 'crop' });
  expect(await capture({
    type: 'capture-finished',
    id: 'crop',
    image: recognize.image,
    name: 'Page crop',
  })).toEqual({ ok: true });
  expect(port.states.at(-1)?.input).toMatchObject({ id: 'crop', name: 'Page crop' });
  expect(port.states.at(-1)?.capture.kind).toBe('idle');
  expect(port.states.at(-1)?.saveError).toBeTruthy();
});

it('clears an unsaved input even while workspace storage remains full', async () => {
  const port = await panel();
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
    throw new DOMException('Disk full', 'QuotaExceededError');
  });
  port.send({ type: 'set-input', image: recognize.image, name: 'Unsaved crop' });
  await port.stateWhen((state) => !!state.saveError);
  port.send({ type: 'clear' });
  await vi.waitFor(() => expect(port.states.at(-1)?.input).toBeNull(), { timeout: 200 });
  expect(port.states.at(-1)?.job.kind).toBe('idle');
});

it('preserves unsaved output through successful and failed history deletion', async () => {
  const port = await panel();
  port.send(recognize);
  await port.stateWhen((state) => state.job.kind === 'running');
  await Promise.resolve();
  const worker = GpuWorker.instances[0];
  if (!worker) throw new Error('Recognition did not create a GPU worker');
  const first = (await complete(port, worker)).result;
  if (!first) throw new Error('Recognition did not complete');
  port.send({ ...recognize, image: 'data:image/png;base64,BBBB' });
  await port.stateWhen((state) => state.job.kind === 'running');
  const second = (await complete(port, worker)).result;
  if (!second) throw new Error('Recognition did not complete');
  const put = IDBObjectStore.prototype.put;
  const full = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (this.name === 'scans') throw new DOMException('Disk full', 'QuotaExceededError');
    return put.call(this, value, key);
  });
  port.send({ type: 'save', id: second.id, text: '$x=corrected$' });
  await port.stateWhen((state) => !!state.saveError);
  port.send({ type: 'delete-scans', ids: [first.id] });
  await port.stateWhen((state) => state.history.length === 1);
  expect(port.states.at(-1)?.result?.edited).toBe('$x=corrected$');
  expect(port.states.at(-1)?.saveError).toBeTruthy();
  expect((await loadState()).result?.edited).toBe('$x=1$');
  full.mockRestore();
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => {
    throw new Error('Deletion failed');
  });
  port.send({ type: 'delete-scans', ids: [second.id] });
  await port.stateWhen((state) => state.job.kind === 'failed');
  expect(port.states.at(-1)?.result?.edited).toBe('$x=corrected$');
  expect(port.states.at(-1)?.history.map((entry) => entry.id)).toEqual([second.id]);
  expect((await loadState()).history.map((entry) => entry.id)).toEqual([second.id]);
});
