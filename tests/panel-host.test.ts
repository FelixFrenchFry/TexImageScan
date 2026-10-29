import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialState } from '../src/state';
import { type AppState, type PanelCommand } from '../src/protocol';
import { usePanelHost } from '../entrypoints/sidepanel/use-panel-host';

const transport = vi.hoisted(() => ({
  ensure: vi.fn(async (message: unknown): Promise<unknown> => {
    if (typeof message !== 'object' || message === null || !('type' in message) ||
        message.type !== 'ensure-host') throw new Error('Expected a host startup request');
    return { ok: true };
  }),
  ports: new Array<HostPort>(),
}));
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      sendMessage: (message: unknown) => transport.ensure(message),
      connect: ({ name }: { name: string }) => {
        if (name !== 'teximagescan-panel') throw new Error('Wrong panel port');
        const port = new HostPort();
        transport.ports.push(port);
        return port;
      },
    },
  },
}));

class HostPort {
  messages: PanelCommand[] = [];
  closed = false;
  private messagesReceived: ((message: unknown) => void)[] = [];
  private disconnected: (() => void)[] = [];
  onMessage = {
    addListener: (listener: (message: unknown) => void) => this.messagesReceived.push(listener),
  };
  onDisconnect = {
    addListener: (listener: () => void) => this.disconnected.push(listener),
  };
  postMessage(command: PanelCommand) {
    if (this.closed) throw new Error('Port closed');
    this.messages.push(command);
  }
  disconnect() {
    this.closed = true;
    for (const listener of this.disconnected) listener();
  }
  receive(message: unknown) {
    for (const listener of this.messagesReceived) listener(message);
  }
}

let renderer: Root;
let container: HTMLElement;
let latest: ReturnType<typeof usePanelHost> | undefined;
const received = vi.fn((_state: AppState) => {});
const disconnected = vi.fn();
function Panel({ onState = received }: { onState?: (state: AppState) => void }) {
  latest = usePanelHost({ onState, onDisconnect: disconnected });
  return createElement('span', null, latest.connection || 'Connected');
}
function host() {
  if (!latest) throw new Error('Panel did not render');
  return latest;
}
async function mount() {
  await act(async () => renderer.render(createElement(Panel)));
  const port = transport.ports[0];
  if (!port) throw new Error('Panel did not connect');
  return port;
}

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="panel"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  transport.ensure.mockReset();
  transport.ports = [];
  received.mockClear();
  disconnected.mockClear();
  latest = undefined;
  const element = window.document.getElementById('panel');
  if (!element) throw new Error('Missing panel container');
  container = element;
  renderer = createRoot(container);
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('waits for validated host state before sending panel commands', async () => {
  const port = await mount();
  expect(() => host().send({ type: 'clear' })).toThrow('reconnecting');
  await act(async () => port.receive({ invalid: true }));
  expect(received).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Connecting');
  await act(async () => port.receive(initialState()));
  expect(container.textContent).toBe('Connected');
  expect(received).toHaveBeenCalledWith(initialState());
  host().send({ type: 'clear' });
  expect(port.messages).toEqual([{ type: 'clear' }]);
});

it('reconnects once and ignores messages from the disconnected port', async () => {
  const port = await mount();
  await act(async () => port.receive(initialState()));
  await act(async () => port.disconnect());
  expect(disconnected).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Reconnecting');
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  const replacement = transport.ports[1];
  if (!replacement) throw new Error('Panel did not reconnect');
  received.mockClear();
  await act(async () => {
    port.receive({ ...initialState(), model: 'ready' });
    port.disconnect();
    replacement.receive({ ...initialState(), model: 'cached' });
  });
  expect(received).toHaveBeenCalledTimes(1);
  expect(received).toHaveBeenCalledWith(expect.objectContaining({ model: 'cached' }));
  expect(container.textContent).toBe('Connected');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(transport.ports).toHaveLength(2);
});

it('matches concurrent result reads to their replies and reports host errors', async () => {
  const port = await mount();
  await act(async () => port.receive(initialState()));
  const first = host().readResult('first');
  const second = host().readResult('second');
  const failure = expect(second).rejects.toThrow('Scan unavailable');
  const requests = port.messages;
  const a = requests[0], b = requests[1];
  if (a?.type !== 'read-result' || b?.type !== 'read-result')
    throw new Error('Missing result requests');
  expect(a).toMatchObject({ resultId: 'first' });
  expect(b).toMatchObject({ resultId: 'second' });
  await act(async () => {
    port.receive({ type: 'result-text', id: b.id, outcome: { ok: false, message: 'Scan unavailable' } });
    port.receive({ type: 'result-text', id: a.id, outcome: { ok: true, text: 'x=1' } });
  });
  await expect(first).resolves.toBe('x=1');
  await failure;
  expect(vi.getTimerCount()).toBe(0);
});

it('times out an unanswered result read and ignores its late reply', async () => {
  const port = await mount();
  await act(async () => port.receive(initialState()));
  const result = host().readResult('first');
  const failure = expect(result).rejects.toThrow('timed out');
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  await failure;
  const request = port.messages[0];
  if (request?.type !== 'read-result') throw new Error('Missing result request');
  await act(async () => port.receive({
    type: 'result-text', id: request.id, outcome: { ok: true, text: 'late' },
  }));
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['disconnect', 'unmount'])(
  'rejects pending result reads and releases their timers on %s',
  async (action) => {
    const port = await mount();
    await act(async () => port.receive(initialState()));
    const result = host().readResult('first');
    const failure = expect(result).rejects.toThrow(action === 'disconnect' ? 'disconnected' : 'closed');
    await act(async () => action === 'disconnect' ? port.disconnect() : renderer.unmount());
    await failure;
    expect(vi.getTimerCount()).toBe(action === 'disconnect' ? 1 : 0);
  },
);

it('uses updated callbacks without reopening the connection', async () => {
  const port = await mount();
  const next = vi.fn();
  await act(async () => renderer.render(createElement(Panel, { onState: next })));
  await act(async () => port.receive(initialState()));
  expect(next).toHaveBeenCalledWith(initialState());
  expect(received).not.toHaveBeenCalled();
  expect(transport.ports).toHaveLength(1);
});

it('does not connect after unmount while host startup is pending', async () => {
  const ready = Promise.withResolvers<unknown>();
  transport.ensure.mockImplementationOnce(() => ready.promise);
  await act(async () => renderer.render(createElement(Panel)));
  await act(async () => renderer.unmount());
  await act(async () => ready.resolve({ ok: true }));
  expect(transport.ports).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('retries a failed host startup and accepts the recovered connection', async () => {
  transport.ensure.mockResolvedValueOnce({ ok: false });
  await act(async () => renderer.render(createElement(Panel)));
  expect(container.textContent).toContain('could not start');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  const port = transport.ports[0];
  if (!port) throw new Error('Panel did not retry');
  await act(async () => port.receive(initialState()));
  expect(container.textContent).toBe('Connected');
});

it('rejects a failed result read send without leaving its timeout running', async () => {
  const port = await mount();
  await act(async () => port.receive(initialState()));
  port.closed = true;
  await expect(host().readResult('first')).rejects.toThrow('Port closed');
  expect(vi.getTimerCount()).toBe(0);
});
