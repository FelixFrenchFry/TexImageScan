import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { browserExecutable, openExtension } from '../scripts/browser.mjs';
import { chromium } from '@playwright/test';

vi.mock('node:fs', async (original) => ({ ...(await original()), existsSync: vi.fn() }));
vi.mock('@playwright/test', () => ({
  chromium: { executablePath: () => '/missing/playwright', launchPersistentContext: vi.fn() },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it('uses an explicit Chrome executable before browser discovery', () => {
  vi.stubEnv('CHROME_PATH', '/custom/chrome');
  existsSync.mockReturnValue(true);
  expect(browserExecutable()).toBe('/custom/chrome');
});

it('discovers installed Chrome when the Playwright download is missing', () => {
  vi.stubEnv('CHROME_PATH', '');
  existsSync.mockImplementation((path) => path.replaceAll('\\', '/').endsWith('/Google/Chrome/Application/chrome.exe'));
  expect(browserExecutable()).toMatch(/Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/);
});

it.each([undefined, 'test-results/retained-profile'])(
  'loads the extension through CDP and waits for the panel with profile %s',
  async (profile) => {
    existsSync.mockReturnValue(true);
    let loaded = false, ready = false;
    const page = {
      goto: async (url) => {
        expect(loaded).toBe(true);
        expect(url).toBe('chrome-extension://extension-id/sidepanel.html');
      },
      waitForFunction: async () => { ready = true; },
    };
    const context = {
      browser: () => ({ newBrowserCDPSession: async () => ({
        send: async (method, payload) => {
          expect(method).toBe('Extensions.loadUnpacked');
          expect(payload.path).toMatch(/chrome-mv3$/);
          loaded = true;
          return { id: 'extension-id' };
        },
        detach: async () => {},
      }) }),
      newPage: async () => page,
      close: async () => {},
    };
    chromium.launchPersistentContext.mockImplementation(async (_profile, options) => {
      expect(options.ignoreDefaultArgs).toContain('--disable-extensions');
      expect(options.args).toContain('--enable-unsafe-extension-debugging');
      expect(options.args).not.toContain('--enable-unsafe-webgpu');
      return context;
    });
    const extension = await openExtension({ profile });
    expect(extension.id).toBe('extension-id');
    expect(ready).toBe(true);
    await extension.close();
  },
);
