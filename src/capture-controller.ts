import { browser, type Browser } from 'wxt/browser';
import { z } from 'zod';
import { viewportSchema, captureReplySchema, captureErrorMessage } from './capture';
import { captureEventSchema, type CaptureEvent } from './protocol';
import {
  saveCaptureSnapshot,
  readCaptureSnapshot,
  deleteCaptureSnapshot,
  clearCaptureSnapshots,
} from './capture-snapshot';

const sessionBase = z.object({
  id: z.string(),
  tabId: z.number(),
  windowId: z.number(),
  startedAt: z.number(),
});
const sessionSchema = z.discriminatedUnion('kind', [
  sessionBase.extend({ kind: z.literal('page'), documentId: z.string() }),
  sessionBase.extend({
    kind: z.literal('image'),
    editorTabId: z.number(),
    phase: z.enum(['opening', 'selecting']).default('opening'),
  }),
]);
type CaptureSession = z.infer<typeof sessionSchema>;
type CaptureCompletion = Exclude<CaptureEvent, { type: 'capture-started' }>;
type CaptureOperation = {
  id: string;
  cancellation: AbortController;
  source?: { tabId: number; windowId: number };
  editorTabId?: number;
  state:
    | { kind: 'starting' | 'selecting' | 'retryable' }
    | { kind: 'finishing'; event: CaptureCompletion; cleanup: Promise<void> };
};
const key = 'teximagescan-capture';

export function installCaptureController(ensureHost: () => Promise<void>): void {
  let operation: CaptureOperation | undefined;
  let sessionChanges = Promise.resolve();
  const session = async () =>
    sessionSchema.safeParse((await browser.storage.session.get(key))[key]);
  // serialize ownership checks and writes, leaving tab and screenshot work cancellable
  function updateSession<T>(change: () => Promise<T>): Promise<T> {
    const task = sessionChanges.then(change);
    sessionChanges = task.then(() => undefined, () => undefined);
    return task;
  }
  const editorURL = (id: string) => `${browser.runtime.getURL('/capture-editor.html')}#${id}`;
  async function host(event: CaptureEvent): Promise<void> {
    await ensureHost();
    const response = captureReplySchema.parse(
      await browser.runtime.sendMessage({ type: 'capture-host', event }),
    );
    if (!response.ok) throw new Error(response.message ?? 'Could not update capture state.');
  }
  function check(current: CaptureOperation): void {
    current.cancellation.signal.throwIfAborted();
    if (operation !== current) throw new DOMException('Capture cancelled.', 'AbortError');
  }
  function waitFor<T>(current: CaptureOperation, task: Promise<T>, timeout?: number): Promise<T> {
    const signal = current.cancellation.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted = () => {};
    return new Promise<T>((resolve, reject) => {
      aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      if (timeout !== undefined)
        timer = setTimeout(
          () => reject(new Error('Capture startup timed out. Capture the area again.')),
          timeout,
        );
      task.then(resolve, reject);
    }).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    });
  }
  async function closeEditor(current: CaptureOperation): Promise<void> {
    if (current.editorTabId === undefined) return;
    const editor = await browser.tabs.get(current.editorTabId).catch(() => undefined);
    // only close a selector or the blank tab created for it, preserving user navigation
    if (
      editor &&
      (editor.url === editorURL(current.id) || editor.url === 'about:blank') &&
      (!editor.pendingUrl || editor.pendingUrl === editorURL(current.id))
    ) {
      await browser.tabs.remove(current.editorTabId).catch(() => undefined);
      if (editor.active && current.source)
        await browser.tabs.update(current.source.tabId, { active: true }).catch(() => undefined);
    }
  }
  function complete(
    current: CaptureOperation,
    event: CaptureCompletion,
    close = true,
  ): Promise<void> {
    if (current.state.kind === 'finishing') return current.state.cleanup;
    const cleanup = updateSession(async () => {
      const saved = await session();
      // keep ownership and screenshot pixels until the host accepts the event
      await host(event);
      if (!saved.success || saved.data.id !== current.id) return;
      await browser.storage.session.remove(key);
      return saved.data;
    })
      .then(async (saved) => {
        if (saved?.kind === 'page') {
          void browser.tabs
            .sendMessage(saved.tabId, { type: 'capture-dismiss', id: saved.id })
            .catch(() => undefined);
        } else {
          try {
            await deleteCaptureSnapshot(current.id);
          } finally {
            if (close) await closeEditor(current);
          }
        }
      })
      .then(() => {
        if (operation === current) operation = undefined;
      })
      .catch((error: unknown) => {
        if (operation === current) current.state = { kind: 'retryable' };
        throw error;
      });
    current.state = { kind: 'finishing', event, cleanup };
    current.cancellation.abort(
      new DOMException(
        event.type === 'capture-failed' ? event.message : 'Capture cancelled.',
        'AbortError',
      ),
    );
    return cleanup;
  }
  async function dismiss(message?: string, expectedId?: string, close = true): Promise<void> {
    const current = operation;
    if (!current || (expectedId !== undefined && current.id !== expectedId)) return;
    await complete(
      current,
      message
        ? { type: 'capture-failed', id: current.id, message }
        : { type: 'capture-cancelled', id: current.id },
      close,
    );
  }
  const initialized = (async () => {
    const saved = await session();
    if (!saved.success) {
      await updateSession(() => browser.storage.session.remove(key));
      await clearCaptureSnapshots();
      return;
    }
    const current = saved.data;
    operation = {
      id: current.id,
      cancellation: new AbortController(),
      source: { tabId: current.tabId, windowId: current.windowId },
      ...(current.kind === 'image' ? { editorTabId: current.editorTabId } : {}),
      state: { kind: 'selecting' },
    };
    const source = await browser.tabs.get(current.tabId).catch(() => undefined);
    const expired = Date.now() - current.startedAt > 125_000;
    if (current.kind === 'image') {
      const editor = await browser.tabs.get(current.editorTabId).catch(() => undefined);
      if (
        !source ||
        expired ||
        !editor?.active ||
        editor.url !== editorURL(current.id) ||
        !(await readCaptureSnapshot(current.id))
      ) {
        await dismiss('The previous capture was interrupted. Capture the area again.', current.id);
        await clearCaptureSnapshots();
      }
    } else {
      await clearCaptureSnapshots();
      if (!source || expired)
        await dismiss('The previous capture was interrupted. Capture the area again.', current.id);
    }
  })().catch(console.error);
  async function begin(tab?: Browser.tabs.Tab, opened = Promise.resolve()): Promise<void> {
    await Promise.all([initialized, opened]);
    if (operation && (operation.state.kind === 'starting' || operation.state.kind === 'finishing'))
      throw new Error('A capture is already starting or finishing.');
    await dismiss();
    // claim startup before waiting for the source tab or its viewport
    if (operation) throw new Error('A capture is already starting or finishing.');
    const current: CaptureOperation = {
      id: crypto.randomUUID(),
      cancellation: new AbortController(),
      state: { kind: 'starting' },
    };
    operation = current;
    const start = async () => {
      const target = tab ?? (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      check(current);
      if (target?.id === undefined)
        throw new Error('Open the tab you want to capture, then try again.');
      current.source = { tabId: target.id, windowId: target.windowId };
      let page: { documentId: string; viewport: z.infer<typeof viewportSchema> } | undefined;
      try {
        const injection = await browser.scripting.executeScript({
          target: { tabId: target.id },
          files: ['/content-scripts/capture.js'],
        });
        check(current);
        const documentId = injection[0]?.documentId;
        if (documentId)
          page = {
            documentId,
            viewport: viewportSchema.parse(
              await waitFor(
                current,
                browser.tabs.sendMessage(target.id, { type: 'capture-viewport' }),
                10_000,
              ),
            ),
          };
      } catch {
        /* Chrome can permit screenshots where overlay injection is blocked */
      }
      check(current);
      if (page && Math.abs(page.viewport.scale - 1) > 0.001)
        throw new Error('Reset pinch zoom before capturing. Normal browser zoom is supported.');
      const screenshot = await browser.tabs.captureVisibleTab(target.windowId, { format: 'png' });
      check(current);
      if (screenshot.length > 48_000_000)
        throw new Error('The browser viewport is too large. Reduce the window size and try again.');
      const active = (await browser.tabs.query({ active: true, windowId: target.windowId }))[0];
      check(current);
      if (active?.id !== target.id) throw new Error('The active tab changed. Capture the area again.');
      const common = {
        id: current.id,
        tabId: target.id,
        windowId: target.windowId,
        startedAt: Date.now(),
      };
      let next: CaptureSession;
      if (page) next = { ...common, kind: 'page', documentId: page.documentId };
      else {
        await updateSession(async () => {
          check(current);
          await saveCaptureSnapshot({
            id: current.id,
            screenshot,
            name: `Page crop - ${target.title || 'webpage'}`.slice(0, 200),
          });
        });
        check(current);
        const editor = await browser.tabs.create({
          windowId: target.windowId,
          url: 'about:blank',
          active: false,
        });
        if (editor.id === undefined) throw new Error('Could not open screenshot selection.');
        current.editorTabId = editor.id;
        if (current.cancellation.signal.aborted) await closeEditor(current);
        check(current);
        next = { ...common, kind: 'image', editorTabId: editor.id, phase: 'opening' };
      }
      await updateSession(async () => {
        check(current);
        await browser.storage.session.set({ [key]: next });
        await host({ type: 'capture-started', id: current.id });
      });
      check(current);
      if (page) {
        const response = captureReplySchema.parse(
          await browser.tabs.sendMessage(
            target.id,
            { type: 'capture-show', id: current.id, screenshot, viewport: page.viewport },
            { documentId: page.documentId },
          ),
        );
        if (!response.ok) throw new Error(response.message ?? 'Could not display capture selection.');
      } else {
        if (next.kind !== 'image') throw new Error('Missing screenshot editor.');
        await browser.tabs.update(next.editorTabId, { url: editorURL(current.id), active: true });
      }
      check(current);
      current.state = { kind: 'selecting' };
    };
    try {
      await waitFor(current, start());
    } catch (error) {
      if (current.state.kind === 'finishing') {
        await current.state.cleanup;
        if (current.state.event.type === 'capture-finished') return;
        throw current.cancellation.signal.reason;
      }
      const message = captureErrorMessage(error);
      await complete(current, { type: 'capture-failed', id: current.id, message }).catch(
        () => undefined,
      );
      throw new Error(message);
    }
  }
  async function finish(event: CaptureCompletion, saved: CaptureSession) {
    const current = operation;
    if (!current || current.id !== saved.id || current.state.kind === 'finishing')
      return { ok: false, message: 'This capture is no longer active.' };
    if (Date.now() - saved.startedAt > 125_000) {
      await dismiss('Capture timed out. Select an area again.', saved.id);
      return { ok: false, message: 'Capture timed out.' };
    }
    const active = (await browser.tabs.query({ active: true, windowId: saved.windowId }))[0];
    if (
      operation !== current ||
      (current.cancellation.signal.aborted && current.state.kind !== 'retryable')
    )
      return { ok: false };
    const expected = saved.kind === 'page' ? saved.tabId : saved.editorTabId;
    if (active?.id !== expected) {
      await dismiss(undefined, saved.id);
      return { ok: false, message: 'The active tab changed.' };
    }
    await complete(current, event);
    return { ok: true };
  }
  browser.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (
      sender.id !== browser.runtime.id ||
      typeof message !== 'object' ||
      message === null ||
      !('type' in message)
    )
      return;
    if (
      (message.type === 'capture-begin' || message.type === 'capture-cancel') &&
      sender.url?.startsWith(browser.runtime.getURL('/'))
    ) {
      const operation =
        message.type === 'capture-begin' ? begin() : initialized.then(() => dismiss());
      void operation.then(
        () => respond({ ok: true }),
        (error: unknown) =>
          respond({
            ok: false,
            message: error instanceof Error ? error.message : 'Capture failed.',
          }),
      );
      return true;
    }
    if (
      (message.type === 'capture-image-get' || message.type === 'capture-image-leave') &&
      'id' in message &&
      typeof message.id === 'string'
    ) {
      const id = message.id;
      const leaving = message.type === 'capture-image-leave';
      void (async () => {
        await initialized;
        const current = await session();
        if (
          !current.success ||
          current.data.kind !== 'image' ||
          current.data.id !== id ||
          sender.tab?.id !== current.data.editorTabId ||
          sender.frameId !== 0 ||
          sender.url !== editorURL(id)
        )
          return { ok: false, message: 'This screenshot selection is no longer available.' };
        if (leaving) {
          await dismiss(undefined, id, false);
          return { ok: true };
        }
        if (Date.now() - current.data.startedAt > 125_000) {
          await dismiss('Capture timed out. Select an area again.', current.data.id);
          return { ok: false, message: 'Capture timed out.' };
        }
        const snapshot = await readCaptureSnapshot(id);
        if (!snapshot)
          return {
            ok: false,
            message: 'This screenshot is no longer available. Capture the area again.',
          };
        return updateSession(async () => {
          const latest = await session();
          if (
            !latest.success ||
            latest.data.kind !== 'image' ||
            latest.data.id !== id ||
            latest.data.editorTabId !== sender.tab?.id
          )
            return { ok: false, message: 'This screenshot selection is no longer available.' };
          if (operation?.id !== id || operation.state.kind === 'finishing')
            return { ok: false, message: 'This screenshot selection is no longer available.' };
          await browser.storage.session.set({ [key]: { ...latest.data, phase: 'selecting' } });
          return { ok: true, snapshot };
        });
      })().then(respond, () =>
        respond({ ok: false, message: 'Could not open screenshot selection.' }),
      );
      return true;
    }
    if (
      (message.type !== 'capture-page-result' && message.type !== 'capture-image-result') ||
      !('event' in message) ||
      sender.frameId !== 0
    )
      return;
    const parsed = captureEventSchema.safeParse(message.event);
    if (!parsed.success || parsed.data.type === 'capture-started') {
      respond({ ok: false });
      return;
    }
    const route = message.type;
    const event = parsed.data;
    void (async () => {
      await initialized;
      const current = await session();
      if (!current.success || current.data.id !== event.id) return { ok: false };
      if (current.data.kind === 'page') {
        if (
          route !== 'capture-page-result' ||
          current.data.tabId !== sender.tab?.id ||
          current.data.documentId !== sender.documentId
        )
          return { ok: false };
      } else if (
        route !== 'capture-image-result' ||
        sender.tab?.id !== current.data.editorTabId ||
        sender.url !== editorURL(event.id)
      )
        return { ok: false };
      return finish(event, current.data);
    })().then(respond, (error: unknown) =>
      respond({
        ok: false,
        message: error instanceof Error ? error.message : 'Could not retain the crop.',
      }),
    );
    return true;
  });
  browser.commands.onCommand.addListener((command, tab) => {
    if (command !== 'capture-area' || !tab || operation?.state.kind === 'starting') return;
    // opening the side panel must retain the user gesture from the shortcut
    void begin(tab, browser.sidePanel.open({ windowId: tab.windowId })).catch(async (error: unknown) => {
      if (operation || (error instanceof DOMException && error.name === 'AbortError')) return;
      const id = crypto.randomUUID();
      await host({ type: 'capture-started', id })
        .then(() => host({
          type: 'capture-failed',
          id,
          message: error instanceof Error ? error.message : 'Capture failed.',
        }))
        .catch(() => undefined);
    });
  });
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    void initialized.then(async () => {
      const current = operation;
      if (
        !current?.source ||
        current.source.windowId !== windowId ||
        current.state.kind === 'finishing'
      )
        return;
      const expected = current.editorTabId ?? current.source.tabId;
      if (tabId !== expected) await dismiss(undefined, current.id);
    }).catch(console.error);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    void initialized.then(async () => {
      const current = operation;
      if (!current || current.state.kind === 'finishing') return;
      if (current.source?.tabId === tabId || current.editorTabId === tabId)
        await dismiss(undefined, current.id);
    }).catch(console.error);
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    void initialized.then(async () => {
      const current = operation;
      if (!current || current.state.kind === 'finishing') return;
      const navigating = change.status === 'loading' || Boolean(change.url);
      if (navigating && current.source?.tabId === tabId) {
        await dismiss(undefined, current.id);
      } else if (current.editorTabId === tabId) {
        if (
          change.url &&
          change.url !== editorURL(current.id) &&
          !(current.state.kind === 'starting' && change.url === 'about:blank')
        ) {
          await dismiss(undefined, current.id, false);
        } else if (change.status === 'complete') {
          const saved = await session();
          if (
            operation !== current ||
            !saved.success ||
            saved.data.kind !== 'image' ||
            saved.data.phase !== 'selecting'
          )
            return;
          const contexts = await browser.runtime.getContexts({
            contextTypes: [browser.runtime.ContextType.TAB],
            tabIds: [tabId],
          });
          if (!contexts.some((context) => context.documentUrl === editorURL(current.id)))
            await dismiss(undefined, current.id, false);
        }
      }
    }).catch(console.error);
  });
  browser.runtime.onStartup.addListener(() => {
    void initialized.then(clearCaptureSnapshots);
  });
  browser.runtime.onInstalled.addListener(() => {
    void initialized.then(async () => {
      await dismiss();
      await clearCaptureSnapshots();
    });
  });
}
