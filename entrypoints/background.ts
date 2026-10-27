import { browser } from 'wxt/browser';
import { installCaptureController } from '../src/capture-controller';

export default defineBackground(() => {
  let opening: Promise<void> | undefined;
  function ensureHost(): Promise<void> {
    opening ??= (async () => {
      const contexts = await browser.runtime.getContexts({
        contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });
      if (contexts.length === 0)
        await browser.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: [browser.offscreen.Reason.WORKERS],
          justification: 'Runs local image recognition in a dedicated WebGPU worker',
        });
    })().finally(() => {
      opening = undefined;
    });
    return opening;
  }
  installCaptureController(ensureHost);
  // the toolbar handler grants activeTab access
  // automatic panel opening does not grant access to the webpage
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
  browser.action.onClicked.addListener((tab) => {
    void browser.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  });
  browser.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (
      sender.id !== browser.runtime.id ||
      typeof message !== 'object' ||
      message === null ||
      !('type' in message) ||
      message.type !== 'ensure-host'
    )
      return;
    ensureHost().then(
      () => respond({ ok: true }),
      () => respond({ ok: false }),
    );
    return true;
  });
});
