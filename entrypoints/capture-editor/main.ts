import { browser } from 'wxt/browser';
import { mountCaptureOverlay } from '../../src/capture-overlay';
import { captureSnapshotReplySchema } from '../../src/capture-snapshot';
import { captureReplySchema } from '../../src/capture';
import './style.css';

const id = location.hash.slice(1);
const cancellation = new AbortController();
const status = document.getElementById('status');
window.addEventListener(
  'pagehide',
  () => {
    void browser.runtime.sendMessage({ type: 'capture-image-leave', id }).catch(() => undefined);
  },
  { once: true },
);
try {
  const reply = captureSnapshotReplySchema.parse(
    await browser.runtime.sendMessage({ type: 'capture-image-get', id }),
  );
  if (!reply.ok) throw new Error(reply.message);
  const viewport = {
    width: innerWidth,
    height: innerHeight,
    scrollX,
    scrollY,
    scale: visualViewport?.scale ?? 1,
  };
  await mountCaptureOverlay({
    ...reply.snapshot,
    viewport,
    fitImage: true,
    signal: cancellation.signal,
    finish: async (event) => {
      const response = captureReplySchema.parse(
        await browser.runtime.sendMessage({ type: 'capture-image-result', event }),
      );
      if (!response.ok) throw new Error(response.message ?? 'Could not retain the crop.');
    },
  });
  status?.remove();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Could not open screenshot selection.';
  if (status) {
    status.setAttribute('role', 'alert');
    status.textContent = message;
  }
  // release the session if decoding or mounting fails
  await browser.runtime
    .sendMessage({
      type: 'capture-image-result',
      event: {
        type: 'capture-failed',
        id,
        message,
      },
    })
    .catch(() => undefined);
}
