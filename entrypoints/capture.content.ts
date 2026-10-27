import { browser } from 'wxt/browser';
import { capturePageMessageSchema, captureReplySchema } from '../src/capture';
import { mountCaptureOverlay } from '../src/capture-overlay';

declare global {
  var __texImageScanCaptureCleanup: (() => void) | undefined;
}

export default defineContentScript({
  matches: [],
  registration: 'runtime',
  main(ctx) {
    globalThis.__texImageScanCaptureCleanup?.();
    let cancel: (() => void) | undefined;
    let captureId: string | undefined;
    let pending: AbortController | undefined;
    let disposed = false;
    const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
      message: unknown,
      sender,
      respond,
    ) => {
      if (disposed || sender.id !== browser.runtime.id || sender.tab) return;
      const parsed = capturePageMessageSchema.safeParse(message);
      if (!parsed.success) return;
      const command = parsed.data;
      if (command.type === 'capture-viewport') {
        ctx.requestAnimationFrame(() =>
          ctx.requestAnimationFrame(() =>
            respond({
              width: innerWidth,
              height: innerHeight,
              scrollX,
              scrollY,
              scale: visualViewport?.scale ?? 1,
            }),
          ),
        );
      } else if (command.type === 'capture-dismiss') {
        if (captureId === command.id) {
          pending?.abort();
          cancel?.();
        }
        respond({ ok: true });
      } else {
        captureId = command.id;
        pending?.abort();
        pending = new AbortController();
        void mountCaptureOverlay({
          ...command,
          signal: pending.signal,
          finish: async (event) => {
            if (browser.runtime?.id) {
              const response = captureReplySchema.parse(
                await browser.runtime.sendMessage({ type: 'capture-page-result', event }),
              );
              if (!response.ok)
                throw new Error(response.message ?? 'Could not retain the crop. Retry or cancel.');
            }
            if (captureId === event.id) {
              cancel = undefined;
              pending = undefined;
              captureId = undefined;
            }
          },
        }).then(
          (cleanup) => {
            cancel = cleanup;
            respond({ ok: true });
          },
          (error: unknown) =>
            respond(
              error instanceof DOMException && error.name === 'AbortError'
                ? { ok: true }
                : {
                    ok: false,
                    message:
                      error instanceof Error
                        ? error.message
                        : 'Could not display capture selection.',
                  },
            ),
        );
      }
      return true;
    };
    browser.runtime.onMessage.addListener(listener);
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      pending?.abort();
      cancel?.();
      // Chrome can remove runtime before WXT invalidates the old script
      if (browser.runtime?.id) browser.runtime.onMessage.removeListener(listener);
      if (globalThis.__texImageScanCaptureCleanup === cleanup)
        globalThis.__texImageScanCaptureCleanup = undefined;
    };
    globalThis.__texImageScanCaptureCleanup = cleanup;
    ctx.onInvalidated(cleanup);
  },
});
