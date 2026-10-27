import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { installCaptureController } from '../src/capture-controller';
import * as snapshots from '../src/capture-snapshot';
import { captureEventSchema } from '../src/protocol';
import { initialState, reduceCaptureEvent } from '../src/state';

type Sender = {
  id: string;
  url: string;
  frameId?: number;
  tab?: { id: number };
  documentId?: string;
};
const transport = vi.hoisted(() => ({
  message: (_message: unknown, _sender: Sender, _respond: (value: unknown) => void) => {},
  stored: new Map<string, unknown>(),
  write: vi.fn(async (_values: Record<string, unknown>) => {}),
  read: vi.fn(async () => {}),
  viewport: vi.fn(async () => ({ width: 1000, height: 720, scrollX: 0, scrollY: 0, scale: 1 })),
  capture: vi.fn(async () => 'data:image/png;base64,AAAA'),
  create: vi.fn(async () => ({ id: 4 })),
  remove: vi.fn(async (_id: number) => {}),
  activate: (_event: { tabId: number; windowId: number }) => {},
  removeTab: (_id: number) => {},
  updateTab: (_id: number, _change: { status?: string; url?: string }) => {},
}));
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'capture-test',
      getURL: (path: string) => 'chrome-extension://capture-test' + path,
      onMessage: {
        addListener: (listener: typeof transport.message) => {
          transport.message = listener;
        },
      },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      sendMessage: vi.fn(),
    },
    storage: {
      session: {
        get: async (key: string) => {
          await transport.read();
          return { [key]: transport.stored.get(key) };
        },
        set: async (values: Record<string, unknown>) => {
          await transport.write(values);
          for (const [key, value] of Object.entries(values)) transport.stored.set(key, value);
        },
        remove: async (key: string) => {
          transport.stored.delete(key);
        },
      },
    },
    tabs: {
      get: async (id: number) => ({
        id,
        active: id === 2,
        url: id === 2 ? 'chrome-extension://capture-test/capture-editor.html#old' : 'about:blank',
      }),
      query: async () => [{ id: 3, windowId: 1, title: 'New page' }],
      sendMessage: async (_id: number, message: { type: string }) =>
        message.type === 'capture-viewport' ? transport.viewport() : { ok: true },
      captureVisibleTab: () => transport.capture(),
      create: () => transport.create(),
      remove: (id: number) => transport.remove(id),
      update: async () => {},
      onActivated: {
        addListener: (listener: typeof transport.activate) => {
          transport.activate = listener;
        },
      },
      onRemoved: {
        addListener: (listener: typeof transport.removeTab) => {
          transport.removeTab = listener;
        },
      },
      onUpdated: {
        addListener: (listener: typeof transport.updateTab) => {
          transport.updateTab = listener;
        },
      },
    },
    scripting: { executeScript: async () => [{ documentId: 'new-document' }] },
    commands: { onCommand: { addListener: () => {} } },
  },
}));

const key = 'teximagescan-capture';
const panel = { id: 'capture-test', url: 'chrome-extension://capture-test/sidepanel.html' };
const editor = {
  id: 'capture-test',
  url: 'chrome-extension://capture-test/capture-editor.html#old',
  frameId: 0,
  tab: { id: 2 },
};
let state = initialState();
function send(message: unknown, sender: Sender = panel): Promise<unknown> {
  return new Promise((resolve) => transport.message(message, sender, resolve));
}

beforeEach(async () => {
  vi.restoreAllMocks();
  transport.stored.clear();
  transport.write.mockReset();
  transport.read.mockReset();
  transport.viewport.mockReset();
  transport.capture.mockReset();
  transport.create.mockReset();
  transport.remove.mockReset();
  state = reduceCaptureEvent(initialState(), { type: 'capture-started', id: 'old' });
  vi.mocked(browser.runtime.sendMessage).mockReset().mockImplementation(async (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('event' in message))
      throw new Error('Expected a capture event');
    state = reduceCaptureEvent(state, captureEventSchema.parse(message.event));
    return { ok: true };
  });
  transport.stored.set(key, {
    id: 'old',
    kind: 'image',
    tabId: 1,
    windowId: 1,
    editorTabId: 2,
    startedAt: Date.now(),
  });
  await snapshots.saveCaptureSnapshot({
    id: 'old',
    screenshot: 'data:image/png;base64,AAAA',
    name: 'Old page',
  });
  installCaptureController(async () => {});
  // wait for recovery before delaying a request from the screenshot editor
  await send({ type: 'capture-image-get', id: 'missing' }, editor);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await snapshots.clearCaptureSnapshots();
});

async function delaySnapshot() {
  const snapshot = await snapshots.readCaptureSnapshot('old');
  const entered = Promise.withResolvers<void>();
  const read = Promise.withResolvers<typeof snapshot>();
  vi.spyOn(snapshots, 'readCaptureSnapshot').mockImplementationOnce(() => {
    entered.resolve();
    return read.promise;
  });
  const reply = send({ type: 'capture-image-get', id: 'old' }, editor);
  await entered.promise;
  return { reply, release: () => read.resolve(snapshot) };
}

it('does not restore a cancelled session when a delayed screenshot read finishes', async () => {
  const read = await delaySnapshot();
  try {
    expect(await send({ type: 'capture-cancel' })).toEqual({ ok: true });
    expect(transport.stored.has(key)).toBe(false);
  } finally {
    read.release();
  }
  expect(await read.reply).toMatchObject({ ok: false });
  expect(transport.stored.has(key)).toBe(false);
  expect(state.capture.kind).toBe('idle');
});

it('keeps a replacement capture usable when an older screenshot read finishes', async () => {
  const read = await delaySnapshot();
  try {
    expect(await send({ type: 'capture-begin' })).toEqual({ ok: true });
  } finally {
    read.release();
  }
  expect(await read.reply).toMatchObject({ ok: false });
  if (state.capture.kind !== 'selecting') throw new Error('Expected a new capture');
  const id = state.capture.id;
  expect(transport.stored.get(key)).toMatchObject({ id, kind: 'page' });
  expect(
    await send(
      {
        type: 'capture-page-result',
        event: {
          type: 'capture-finished',
          id,
          image: 'data:image/png;base64,BBBB',
          name: 'New crop',
        },
      },
      {
        id: 'capture-test',
        url: 'https://example.com/',
        frameId: 0,
        tab: { id: 3 },
        documentId: 'new-document',
      },
    ),
  ).toEqual({ ok: true });
  expect(state.input?.name).toBe('New crop');
  expect(state.capture.kind).toBe('idle');
});

it('does not let an in-flight phase write outlive cancellation', async () => {
  const entered = Promise.withResolvers<void>();
  const write = Promise.withResolvers<void>();
  transport.write.mockImplementationOnce(() => {
    entered.resolve();
    return write.promise;
  });
  const reply = send({ type: 'capture-image-get', id: 'old' }, editor);
  await entered.promise;
  const cancelled = send({ type: 'capture-cancel' });
  // let cancellation reach session storage while the phase write is pending
  await new Promise<void>((resolve) => setImmediate(resolve));
  write.resolve();
  expect(await reply).toMatchObject({ ok: true });
  expect(await cancelled).toEqual({ ok: true });
  expect(transport.stored.has(key)).toBe(false);
  expect(state.capture.kind).toBe('idle');
});

async function delayViewport() {
  const entered = Promise.withResolvers<void>();
  const read = Promise.withResolvers<Awaited<ReturnType<typeof transport.viewport>>>();
  transport.viewport.mockImplementationOnce(() => {
    entered.resolve();
    return read.promise;
  });
  const reply = send({ type: 'capture-begin' });
  const settled = vi.fn();
  void reply.then(settled);
  await entered.promise;
  return {
    reply,
    settled,
    release: () => read.resolve({ width: 1000, height: 720, scrollX: 0, scrollY: 0, scale: 1 }),
  };
}

it('cancels startup without waiting for a viewport reply and allows another capture', async () => {
  const read = await delayViewport();
  try {
    expect(await send({ type: 'capture-cancel' })).toEqual({ ok: true });
    await vi.waitFor(
      () => expect(read.settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false })),
      { timeout: 200 },
    );
    expect(await send({ type: 'capture-begin' })).toEqual({ ok: true });
    const current = transport.stored.get(key);
    read.release();
    await read.reply;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport.stored.get(key)).toEqual(current);
  } finally {
    read.release();
    await read.reply;
  }
});

it.each(['switch', 'close', 'navigate'])(
  'releases startup on source %s before a viewport reply arrives',
  async (change) => {
    const read = await delayViewport();
    try {
      if (change === 'switch') transport.activate({ tabId: 9, windowId: 1 });
      else if (change === 'close') transport.removeTab(3);
      else transport.updateTab(3, { status: 'loading' });
      await vi.waitFor(
        () => expect(read.settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false })),
        { timeout: 200 },
      );
      expect(await send({ type: 'capture-begin' })).toEqual({ ok: true });
    } finally {
      read.release();
      await read.reply;
    }
  },
);

it('ignores a screenshot that arrives after startup cancellation', async () => {
  const entered = Promise.withResolvers<void>();
  const screenshot = Promise.withResolvers<string>();
  transport.capture.mockImplementationOnce(() => {
    entered.resolve();
    return screenshot.promise;
  });
  const reply = send({ type: 'capture-begin' });
  const settled = vi.fn();
  void reply.then(settled);
  await entered.promise;
  try {
    expect(await send({ type: 'capture-cancel' })).toEqual({ ok: true });
    await vi.waitFor(
      () => expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false })),
      { timeout: 200 },
    );
    expect(await send({ type: 'capture-begin' })).toEqual({ ok: true });
    const current = transport.stored.get(key);
    screenshot.resolve('data:image/png;base64,BBBB');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport.stored.get(key)).toEqual(current);
  } finally {
    screenshot.resolve('data:image/png;base64,BBBB');
    await reply;
  }
});

it('closes an editor created after cancellation without changing the replacement capture', async () => {
  vi.spyOn(browser.scripting, 'executeScript').mockRejectedValueOnce(new Error('Overlay blocked'));
  const entered = Promise.withResolvers<void>();
  const editor = Promise.withResolvers<{ id: number }>();
  transport.create.mockImplementationOnce(() => {
    entered.resolve();
    return editor.promise;
  });
  const reply = send({ type: 'capture-begin' });
  await entered.promise;
  try {
    expect(await send({ type: 'capture-cancel' })).toEqual({ ok: true });
    expect(await send({ type: 'capture-begin' })).toEqual({ ok: true });
    const current = transport.stored.get(key);
    editor.resolve({ id: 4 });
    await vi.waitFor(() => expect(transport.remove).toHaveBeenCalledWith(4));
    expect(transport.stored.get(key)).toEqual(current);
  } finally {
    editor.resolve({ id: 4 });
    await reply;
  }
});

it('falls back to the screenshot editor when the viewport request stops responding', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const read = await delayViewport();
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await read.reply).toEqual({ ok: true });
    expect(transport.stored.get(key)).toMatchObject({ kind: 'image', editorTabId: 4 });
    expect(await send({ type: 'capture-cancel' })).toEqual({ ok: true });
  } finally {
    read.release();
    vi.useRealTimers();
  }
});

it('finishes once and retains ownership until the host accepts the result', async () => {
  expect(await send({ type: 'capture-begin' })).toEqual({ ok: true });
  if (state.capture.kind !== 'selecting') throw new Error('Expected a capture');
  const id = state.capture.id;
  const entered = Promise.withResolvers<void>();
  const accept = Promise.withResolvers<void>();
  vi.mocked(browser.runtime.sendMessage).mockImplementationOnce(async (message: unknown) => {
    entered.resolve();
    await accept.promise;
    if (typeof message !== 'object' || message === null || !('event' in message))
      throw new Error('Expected a capture event');
    state = reduceCaptureEvent(state, captureEventSchema.parse(message.event));
    return { ok: true };
  });
  const message = {
    type: 'capture-page-result',
    event: { type: 'capture-finished', id, image: 'data:image/png;base64,BBBB', name: 'New crop' },
  };
  const sender = {
    id: 'capture-test',
    url: 'https://example.com/',
    frameId: 0,
    tab: { id: 3 },
    documentId: 'new-document',
  };
  const reply = send(message, sender);
  await entered.promise;
  try {
    expect(transport.stored.get(key)).toMatchObject({ id });
    expect(await send(message, sender)).toMatchObject({ ok: false });
    expect(await send({ type: 'capture-begin' })).toMatchObject({ ok: false });
  } finally {
    accept.resolve();
  }
  expect(await reply).toEqual({ ok: true });
  expect(state.input?.name).toBe('New crop');
  expect(await send({ type: 'capture-begin' })).toEqual({ ok: true });
});

async function pageCompletion() {
  expect(await send({ type: 'capture-begin' })).toEqual({ ok: true });
  if (state.capture.kind !== 'selecting') throw new Error('Expected a capture');
  const id = state.capture.id;
  return {
    id,
    message: {
      type: 'capture-page-result',
      event: { type: 'capture-finished', id, image: 'data:image/png;base64,BBBB', name: 'New crop' },
    },
    sender: {
      id: 'capture-test',
      url: 'https://example.com/',
      frameId: 0,
      tab: { id: 3 },
      documentId: 'new-document',
    },
  };
}

it('retains a failed completion for retry and accepts the same crop on the next attempt', async () => {
  const { id, message, sender } = await pageCompletion();
  vi.mocked(browser.runtime.sendMessage).mockRejectedValueOnce(new Error('Host unavailable'));
  expect(await send(message, sender)).toMatchObject({ ok: false, message: 'Host unavailable' });
  expect(transport.stored.get(key)).toMatchObject({ id });
  expect(state.capture).toEqual({ kind: 'selecting', id });
  expect(await send(message, sender)).toEqual({ ok: true });
  expect(state.input).toMatchObject({ id, name: 'New crop' });
  expect(state.capture.kind).toBe('idle');
  expect(transport.stored.has(key)).toBe(false);
});

it('reports a failed cancellation and lets Cancel retry after a failed completion', async () => {
  const { message, sender } = await pageCompletion();
  vi.mocked(browser.runtime.sendMessage).mockRejectedValueOnce(new Error('Host unavailable'));
  expect(await send(message, sender)).toMatchObject({ ok: false });
  vi.mocked(browser.runtime.sendMessage).mockRejectedValueOnce(new Error('Host still unavailable'));
  expect(await send({ type: 'capture-cancel' })).toMatchObject({
    ok: false,
    message: 'Host still unavailable',
  });
  expect(transport.stored.has(key)).toBe(true);
  expect(await send({ type: 'capture-cancel' })).toEqual({ ok: true });
  expect(state.capture.kind).toBe('idle');
  expect(transport.stored.has(key)).toBe(false);
  expect(await send({ type: 'capture-begin' })).toEqual({ ok: true });
});

it('retries cleanup when the host accepted the crop but its acknowledgement was lost', async () => {
  const { id, message, sender } = await pageCompletion();
  vi.mocked(browser.runtime.sendMessage).mockImplementationOnce(async (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('event' in message))
      throw new Error('Expected a capture event');
    state = reduceCaptureEvent(state, captureEventSchema.parse(message.event));
    throw new Error('Acknowledgement lost');
  });
  expect(await send(message, sender)).toMatchObject({ ok: false });
  expect(state.input?.id).toBe(id);
  expect(transport.stored.get(key)).toMatchObject({ id });
  expect(await send(message, sender)).toEqual({ ok: true });
  expect(state.input?.id).toBe(id);
  expect(transport.stored.has(key)).toBe(false);
  expect(await send({ type: 'capture-begin' })).toEqual({ ok: true });
});

it('keeps screenshot pixels until the host accepts cancellation', async () => {
  vi.mocked(browser.runtime.sendMessage).mockRejectedValueOnce(new Error('Host unavailable'));
  expect(await send({ type: 'capture-cancel' })).toMatchObject({ ok: false });
  expect(transport.stored.get(key)).toMatchObject({ id: 'old' });
  expect(await snapshots.readCaptureSnapshot('old')).toBeDefined();
  expect(transport.remove).not.toHaveBeenCalled();
  expect(await send({ type: 'capture-cancel' })).toEqual({ ok: true });
  expect(await snapshots.readCaptureSnapshot('old')).toBeUndefined();
  expect(transport.remove).toHaveBeenCalledWith(2);
});

it('can cancel after host delivery fails during startup recovery', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  transport.stored.set(key, {
    id: 'expired', kind: 'page', tabId: 3, windowId: 1,
    documentId: 'new-document', startedAt: Date.now() - 126_000,
  });
  state = reduceCaptureEvent(initialState(), { type: 'capture-started', id: 'expired' });
  vi.mocked(browser.runtime.sendMessage).mockRejectedValueOnce(new Error('Host unavailable'));
  installCaptureController(async () => {});
  await send({ type: 'capture-image-get', id: 'missing' }, editor);
  expect(transport.stored.get(key)).toMatchObject({ id: 'expired' });
  expect(await send({ type: 'capture-cancel' })).toEqual({ ok: true });
  expect(state.capture.kind).toBe('idle');
  expect(transport.stored.has(key)).toBe(false);
});

it.each(['switch', 'navigate'])(
  'handles source %s while a stored capture is recovering',
  async (change) => {
    transport.stored.set(key, {
      id: 'recovered',
      kind: 'page',
      tabId: 3,
      windowId: 1,
      documentId: 'new-document',
      startedAt: Date.now(),
    });
    state = reduceCaptureEvent(initialState(), { type: 'capture-started', id: 'recovered' });
    const entered = Promise.withResolvers<void>();
    const restored = Promise.withResolvers<void>();
    transport.read.mockImplementationOnce(() => {
      entered.resolve();
      return restored.promise;
    });
    installCaptureController(async () => {});
    await entered.promise;
    if (change === 'switch') transport.activate({ tabId: 9, windowId: 1 });
    else transport.updateTab(3, { status: 'loading' });
    restored.resolve();
    await send({ type: 'capture-image-get', id: 'missing' }, editor);
    await vi.waitFor(() => {
      expect(transport.stored.has(key)).toBe(false);
      expect(state.capture.kind).toBe('idle');
    }, { timeout: 200 });
  },
);
