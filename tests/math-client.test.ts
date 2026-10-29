import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installAccuracyClient, recognizePrepared } from '../scripts/math-benchmark/client';

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  terminated = false;
  requests: unknown[] = [];

  constructor() {
    super();
    TestWorker.instances.push(this);
  }
  postMessage(request: unknown): void { this.requests.push(request); }
  terminate(): void { this.terminated = true; }
  reply(value: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: value })); }
}

beforeEach(() => {
  vi.useFakeTimers();
  TestWorker.instances = [];
  vi.stubGlobal('window', {});
  vi.stubGlobal('Worker', TestWorker);
  installAccuracyClient({ timeoutMs: 25 });
});
afterEach(() => {
  window.resetAccuracyWorker();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function lastWorker(): TestWorker {
  const worker = TestWorker.instances.at(-1);
  if (!worker) throw new Error('The installer did not create a worker');
  return worker;
}

function replyReady(worker: TestWorker, gpu = 'test GPU'): void {
  const request = worker.requests.at(-1);
  if (typeof request !== 'object' || request === null || !('id' in request) || typeof request.id !== 'string')
    throw new Error('Expected a command with an ID');
  worker.reply({ type: 'ready', id: request.id, gpu });
}

it.each(['timeout', 'error'])('prepares the replacement after an inference %s before recognizing again', async (reason) => {
  const first = window.accuracyCommand({ type: 'recognize', id: 'A' });
  const failure = expect(first).rejects.toThrow(reason === 'timeout' ? 'Worker command timeout' : 'device lost');
  const oldWorker = lastWorker();
  if (reason === 'timeout') await vi.advanceTimersByTimeAsync(25);
  else oldWorker.reply({ type: 'error', id: 'A', error: 'device lost' });
  await failure;

  const next = recognizePrepared({ request: { type: 'recognize', id: 'B' }, gpu: 'test GPU' });
  void next.catch(() => {});
  const replacement = lastWorker();
  expect(replacement).not.toBe(oldWorker);
  expect(replacement.requests).toEqual([{ type: 'prepare', id: expect.any(String) }]);
  await vi.advanceTimersByTimeAsync(10);
  expect(replacement.requests).toHaveLength(1);
  replyReady(replacement);
  await Promise.resolve();
  expect(replacement.requests.at(-1)).toEqual({ type: 'recognize', id: 'B' });
  const reply = { type: 'result', id: 'B', outcome: { elapsedMs: 3 } };
  replacement.reply(reply);
  await expect(next).resolves.toEqual(reply);
  expect(vi.getTimerCount()).toBe(0);
});

it('prepares every case while reusing the worker after successful recognition', async () => {
  for (const id of ['A', 'B']) {
    const pending = recognizePrepared({ request: { type: 'recognize', id }, gpu: 'test GPU' });
    void pending.catch(() => {});
    const worker = lastWorker();
    expect(worker.requests.at(-1)).toMatchObject({ type: 'prepare' });
    replyReady(worker);
    await Promise.resolve();
    expect(worker.requests.at(-1)).toEqual({ type: 'recognize', id });
    worker.reply({ type: 'result', id, outcome: { elapsedMs: 3 } });
    await expect(pending).resolves.toMatchObject({ type: 'result', id });
  }
  expect(TestWorker.instances).toHaveLength(1);
});

it.each(['error', 'timeout'])('does not recognize when preparation fails with an %s', async (reason) => {
  const pending = recognizePrepared({ request: { type: 'recognize', id: 'A' }, gpu: 'test GPU' });
  const failure = expect(pending).rejects.toThrow(reason === 'timeout' ? 'Worker command timeout' : 'preparation failed');
  const worker = lastWorker();
  if (reason === 'timeout') await vi.advanceTimersByTimeAsync(25);
  else {
    const request = worker.requests.at(-1);
    if (typeof request !== 'object' || request === null || !('id' in request)) throw new Error('Missing command');
    worker.reply({ type: 'error', id: request.id, error: 'preparation failed' });
  }
  await failure;
  expect(worker.requests).toEqual([{ type: 'prepare', id: expect.any(String) }]);
  expect(worker.terminated).toBe(true);
});

it.each([
  ['', 'ready GPU'],
  ['different GPU', 'GPU changed'],
])('rejects an invalid or changed GPU (%s) before submitting a timed recognition', async (gpu, message) => {
  const pending = recognizePrepared({ request: { type: 'recognize', id: 'A' }, gpu: 'original GPU' });
  const failure = expect(pending).rejects.toThrow(message);
  const worker = lastWorker();
  replyReady(worker, gpu);
  await failure;
  expect(worker.requests).toEqual([{ type: 'prepare', id: expect.any(String) }]);
});

it('keeps preparation callable after Playwright serialization', async () => {
  const reconstructed: unknown = Function(`return (${recognizePrepared.toString()})`)();
  if (typeof reconstructed !== 'function') throw new Error('The serialized recognizer is not callable');
  const pending = reconstructed({ request: { type: 'recognize', id: 'A' }, gpu: 'test GPU' });
  void pending.catch(() => {});
  const worker = lastWorker();
  expect(worker.requests.at(-1)).toMatchObject({ type: 'prepare' });
  replyReady(worker);
  await Promise.resolve();
  worker.reply({ type: 'result', id: 'A' });
  await expect(pending).resolves.toEqual({ type: 'result', id: 'A' });
});

it('times out A, replaces its worker, and accepts only the matching reply for B', async () => {
  const first = window.accuracyCommand({ type: 'recognize', id: 'A' });
  const failure = expect(first).rejects.toThrow('Worker command timeout');
  const oldWorker = lastWorker();
  await vi.advanceTimersByTimeAsync(25);
  await failure;
  expect(oldWorker.terminated).toBe(true);

  const second = window.accuracyCommand({ type: 'recognize', id: 'B' });
  const replacement = lastWorker();
  expect(replacement).not.toBe(oldWorker);
  let settled = false;
  void second.then(() => { settled = true; });
  oldWorker.reply({ type: 'result', id: 'B', outcome: 'late old worker' });
  replacement.reply({ type: 'result', id: 'A', outcome: 'wrong case' });
  replacement.reply({ type: 'progress', id: 'B', detail: 'reading' });
  await Promise.resolve();
  expect(settled).toBe(false);
  const reply = { type: 'result', id: 'B', outcome: 'correct case' };
  replacement.reply(reply);
  await expect(second).resolves.toEqual(reply);
  expect(vi.getTimerCount()).toBe(0);
});

it('reset rejects the pending request and removes its timeout and listeners', async () => {
  const first = window.accuracyCommand({ type: 'recognize', id: 'same-id' });
  const failure = expect(first).rejects.toThrow('Worker reset');
  const oldWorker = lastWorker();
  window.resetAccuracyWorker();
  await failure;
  expect(oldWorker.terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);

  const second = window.accuracyCommand({ type: 'recognize', id: 'same-id' });
  const replacement = lastWorker();
  oldWorker.reply({ type: 'error', id: 'same-id', error: 'late reset reply' });
  const reply = { type: 'result', id: 'same-id', outcome: 'after reset' };
  replacement.reply(reply);
  await expect(second).resolves.toEqual(reply);
  expect(replacement.terminated).toBe(false);
});

it('terminates a worker after a matching error and retries on a new worker', async () => {
  const first = window.accuracyCommand({ type: 'recognize', id: 'A' });
  const failure = expect(first).rejects.toThrow('device lost');
  const oldWorker = lastWorker();
  oldWorker.reply({ type: 'error', id: 'A', error: 'device lost' });
  await failure;
  expect(oldWorker.terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  const second = window.accuracyCommand({ type: 'prepare', id: 'prepare' });
  const reply = { type: 'ready', id: 'prepare' };
  lastWorker().reply(reply);
  await expect(second).resolves.toEqual(reply);
  expect(TestWorker.instances).toHaveLength(2);
});

it('cleans up when the Worker emits an execution error', async () => {
  const pending = window.accuracyCommand({ type: 'recognize', id: 'A' });
  const failure = expect(pending).rejects.toThrow('Worker execution failed');
  const worker = lastWorker();
  worker.dispatchEvent(new Event('error'));
  await failure;
  expect(worker.terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects overlap and invalid IDs without replacing or interrupting the active request', async () => {
  await expect(window.accuracyCommand({ type: 'prepare' })).rejects.toThrow('Command ID is required');
  expect(TestWorker.instances).toHaveLength(0);
  const active = window.accuracyCommand({ type: 'prepare', id: 'prepare' });
  await expect(window.accuracyCommand({ type: 'prepare', id: 'overlap' })).rejects.toThrow('Overlapping commands');
  expect(TestWorker.instances).toHaveLength(1);
  const reply = { type: 'ready', id: 'prepare' };
  lastWorker().reply(reply);
  await expect(active).resolves.toEqual(reply);
});

it('installs after serialization without module scope dependencies', async () => {
  const reconstructed: unknown = Function(`return (${installAccuracyClient.toString()})`)();
  expect(typeof reconstructed).toBe('function');
  if (typeof reconstructed !== 'function') throw new Error('The serialized installer is not callable');
  reconstructed({ timeoutMs: 25 });
  const pending = window.accuracyCommand({ type: 'prepare', id: 'serialized' });
  const reply = { type: 'ready', id: 'serialized' };
  lastWorker().reply(reply);
  await expect(pending).resolves.toEqual(reply);
});
