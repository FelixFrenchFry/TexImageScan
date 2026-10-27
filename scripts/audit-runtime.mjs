import { resolve } from 'node:path';
import { openExtension } from './browser.mjs';

// clear the previous crop before reusing a smoke-test profile
// keep its downloaded model and scan history
async function clearTestWorkspace() {
  const extension = await openExtension({
    profile: resolve('.cache/production-profile'),
    gpu: false,
  });
  try {
    await extension.page.evaluate(
      () =>
        new Promise((resolve) => {
          const port = chrome.runtime.connect({ name: 'teximagescan-panel' });
          let sent = false;
          port.onMessage.addListener((state) => {
            if (!sent) {
              sent = true;
              port.postMessage({ type: 'clear' });
            } else if (!state.result && !state.input) {
              port.disconnect();
              resolve();
            }
          });
        }),
    );
  } finally {
    await extension.close();
  }
}

await clearTestWorkspace();
await import('./test-production.mjs');
if (process.exitCode) process.exit(process.exitCode);
await clearTestWorkspace();
await import('./test-auto-ui.mjs');
