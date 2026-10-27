import { browser, type Browser } from 'wxt/browser';
import {
  captureEventSchema,
  commandSchema,
  PORT_NAME,
  workerEventSchema,
  type PanelCommand,
  type WorkerCommand,
  type HistoryExportReply,
} from '../../src/protocol';
import { initialState, reduceWorkerEvent, reduceCaptureEvent } from '../../src/state';
import {
  loadState,
  saveWorkspace,
  saveScan,
  loadScan,
  deleteScans,
  exportScans,
} from '../../src/storage';
import { upsertHistory, removeScans } from '../../src/history';
import { cacheReady, removeModelCaches } from '../../src/model-cache';

class SaveError extends Error {}

let state = initialState();
let unsavedResult = false;
let worker: Worker | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const ports = new Set<Browser.runtime.Port>();
let commands = Promise.resolve();
const initialized = loadState()
  .then(async (saved) => {
    state = saved;
    state.model = (await cacheReady()) ? 'cached' : 'missing';
  })
  .catch(() => {
    state.job = {
      kind: 'failed',
      message: 'Local result storage could not be opened. Check available browser storage.',
    };
  });

function broadcast(): void {
  for (const port of ports) {
    try {
      port.postMessage(state);
    } catch {
      ports.delete(port);
    }
  }
}

function reportSaveError(): string {
  const message =
    'Local changes could not be saved. Retry saving or copy your result before closing Chrome.';
  state.saveError = message;
  broadcast();
  return message;
}

async function rememberWorkspace(): Promise<void> {
  try {
    await saveWorkspace(structuredClone(state));
    if (!unsavedResult) state.saveError = null;
  } catch {
    reportSaveError();
  }
}

async function saveResult(): Promise<void> {
  const result = state.result;
  if (!result) return;
  try {
    await saveScan(structuredClone({ ...state, result }));
    unsavedResult = false;
    state.saveError = null;
    state.history = upsertHistory(state.history, result);
  } catch (error) {
    throw new SaveError(reportSaveError(), { cause: error });
  }
}

function releaseWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  worker?.terminate();
  worker = undefined;
  if (state.model === 'ready') state.model = 'cached';
}

function scheduleRelease(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    releaseWorker();
    broadcast();
  }, 5 * 60_000);
}

function getWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(new URL('../../src/recognition.worker.ts', import.meta.url), {
    type: 'module',
  });
  instance.onmessage = (message: MessageEvent<unknown>) => {
    // ignore events from a replaced worker or completed job
    const event = workerEventSchema.safeParse(message.data);
    if (!event.success) return;
    void enqueue(async () => {
      if (worker !== instance) return;
      const next = reduceWorkerEvent(state, event.data);
      if (next === state) return;
      state = next;
      if (event.data.type !== 'progress') {
        if (event.data.type === 'failed' || event.data.type === 'device-lost') releaseWorker();
        if (event.data.type === 'failed') {
          const cached = await cacheReady().catch(() => false);
          state.model = cached ? 'cached' : 'missing';
        }
        scheduleRelease();
        if (event.data.type === 'result') {
          unsavedResult = true;
          await saveResult();
        } else await rememberWorkspace();
      }
      broadcast();
    }).catch(() => undefined);
  };
  instance.onerror = (error) => {
    void enqueue(async () => {
      if (worker !== instance) return;
      releaseWorker();
      state.job = {
        kind: 'failed',
        message: `The recognition worker stopped: ${error.message || 'GPU or runtime failure'}`,
      };
      broadcast();
      await rememberWorkspace();
    }).catch(() => undefined);
  };
  worker = instance;
  return instance;
}

async function handle(command: PanelCommand): Promise<void> {
  if (state.capture.kind === 'selecting' && command.type !== 'save') return;
  if (state.job.kind === 'running' && command.type !== 'cancel') return;
  if (
    unsavedResult &&
    ((command.type === 'open-scan' && command.id !== state.result?.id) ||
      (command.type === 'clear' && !command.discard) ||
      command.type === 'recognize')
  )
    await saveResult();
  switch (command.type) {
    case 'export-history':
      return;
    case 'open-scan': {
      const result = state.result?.id === command.id ? state.result : await loadScan(command.id);
      if (!result) throw new Error('This scan is no longer available.');
      state.result = result;
      state.input = { id: result.id, image: result.image, name: result.name };
      state.job = { kind: 'idle' };
      state.capture = { kind: 'idle' };
      break;
    }
    case 'delete-scans':
    case 'clear-history': {
      const ids =
        command.type === 'delete-scans' ? command.ids : state.history.map((entry) => entry.id);
      const next = removeScans(state, ids);
      await deleteScans(next, ids);
      state = next;
      if (!state.result) unsavedResult = false;
      if (!unsavedResult) state.saveError = null;
      broadcast();
      return;
    }
    case 'set-input':
      state.input = { id: crypto.randomUUID(), image: command.image, name: command.name };
      state.capture = { kind: 'idle' };
      state.job = { kind: 'idle' };
      break;
    case 'cancel':
      if (state.job.kind !== 'running') return;
      releaseWorker();
      state.model = (await cacheReady()) ? 'cached' : 'missing';
      state.job = { kind: 'cancelled' };
      break;
    case 'clear':
      unsavedResult = false;
      state.result = null;
      state.input = null;
      state.capture = { kind: 'idle' };
      state.job = { kind: 'idle' };
      break;
    case 'save':
      if (state.result?.id !== command.id) return;
      state.result = { ...state.result, edited: command.text };
      unsavedResult = true;
      await saveResult();
      broadcast();
      return;
    case 'retry-save':
      if (state.job.kind === 'failed' && state.job.message === state.saveError)
        state.job = { kind: 'idle' };
      if (unsavedResult) await saveResult();
      else await rememberWorkspace();
      broadcast();
      return;
    case 'remove-model':
      releaseWorker();
      await removeModelCaches();
      state.model = 'missing';
      state.job = { kind: 'idle' };
      break;
    case 'prepare':
    case 'recognize': {
      const id = crypto.randomUUID();
      if (command.type === 'recognize' && state.input?.image !== command.image)
        state.input = { id, image: command.image, name: command.name };
      state.job = {
        kind: 'running',
        id,
        phase: command.type === 'prepare' ? 'downloading' : 'loading',
        detail: 'Starting…',
        fraction: null,
        text: '',
      };
      broadcast();
      const request: WorkerCommand =
        command.type === 'prepare' ? { type: 'prepare', id } : { ...command, id };
      if (idleTimer) clearTimeout(idleTimer);
      getWorker().postMessage(request);
      await rememberWorkspace();
      broadcast();
      return;
    }
  }
  await rememberWorkspace();
  broadcast();
}

function enqueue(operation: () => Promise<void>): Promise<void> {
  const task = commands.then(() => initialized).then(operation);
  commands = task.catch(() => undefined);
  return task;
}

// the background validates the tab, document and session before forwarding events
browser.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL('/')))
    return;
  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'capture-host' ||
    !('event' in message)
  )
    return;
  const parsed = captureEventSchema.safeParse(message.event);
  if (!parsed.success) {
    respond({ ok: false, message: 'Invalid capture event' });
    return;
  }
  void enqueue(async () => {
    const event = parsed.data;
    // a completion may be accepted even when its reply never reaches the controller
    // replays acknowledge existing input without overwriting a newer workspace
    if (
      event.type !== 'capture-started' &&
      (state.input?.id === event.id ||
        (event.type !== 'capture-finished' && state.capture.kind !== 'selecting'))
    )
      return;
    if (event.type === 'capture-started' && state.job.kind === 'running')
      throw new Error('Wait for recognition or cancel it before capturing.');
    if (
      event.type !== 'capture-started' &&
      (state.capture.kind !== 'selecting' || state.capture.id !== event.id)
    )
      throw new Error('This capture is no longer active.');
    state = reduceCaptureEvent(state, event);
    await rememberWorkspace();
    broadcast();
  }).then(
    () => respond({ ok: true }),
    (error: unknown) =>
      respond({
        ok: false,
        message: error instanceof Error ? error.message : 'Could not retain the captured image',
      }),
  );
  return true;
});

browser.runtime.onConnect.addListener((port) => {
  if (
    port.name !== PORT_NAME ||
    port.sender?.id !== browser.runtime.id ||
    !port.sender.url?.startsWith(browser.runtime.getURL('/'))
  )
    return;
  ports.add(port);
  void initialized.then(() => {
    if (ports.has(port)) port.postMessage(state);
  });
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((message: unknown) => {
    const parsed = commandSchema.safeParse(message);
    if (!parsed.success) return;
    void enqueue(async () => {
      const command = parsed.data;
      if (command.type === 'export-history') {
        let outcome: HistoryExportReply['outcome'];
        try {
          const text = await exportScans(command.ids, command.format, state.result ?? undefined);
          outcome = { ok: true, text };
        } catch (error) {
          outcome = {
            ok: false,
            message: error instanceof Error ? error.message : 'Could not copy selected scans.',
          };
        }
        if (!ports.has(port)) return;
        try {
          port.postMessage({
            type: 'history-exported',
            id: command.id,
            outcome,
          } satisfies HistoryExportReply);
        } catch {
          ports.delete(port);
        }
        return;
      }
      await handle(command);
    }).catch((error: unknown) => {
      if (!(error instanceof SaveError))
        state.job = {
          kind: 'failed',
          message: error instanceof Error ? error.message : 'The local operation failed',
        };
      broadcast();
    });
  });
});
