import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';

export function browserExecutable() {
  const candidates = [process.env.CHROME_PATH, chromium.executablePath()];
  const executable = candidates.find((path) => path && existsSync(path));
  if (!executable)
    throw new Error(
      'Install a test browser with pnpm exec playwright install chromium, or set CHROME_PATH',
    );
  return executable;
}

export async function openExtension({
  directory = process.env.TEXIMAGESCAN_TEST_BUILD ?? '.output/chrome-mv3',
  profile,
  gpu = true,
  extensionDebug = false,
  deviceScaleFactor = 1,
  headless = true,
  viewport = { width: 430, height: 1100 },
} = {}) {
  if (!profile) await mkdir('test-results', { recursive: true });
  const temporary = profile ?? (await mkdtemp(resolve('test-results/profile-')));
  const extension = resolve(directory);
  const context = await chromium.launchPersistentContext(temporary, {
    executablePath: browserExecutable(),
    headless,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      ...(gpu ? ['--enable-unsafe-webgpu'] : []),
      ...(extensionDebug || profile ? ['--enable-unsafe-extension-debugging'] : []),
    ],
    viewport,
    deviceScaleFactor,
  });
  async function close() {
    await context.close();
    if (!profile) {
      if (!temporary.startsWith(resolve('test-results') + sep))
        throw new Error('Test profile is outside the expected directory');
      await rm(temporary, { recursive: true, force: true });
    }
  }
  try {
    let id;
    if (profile) {
      // reload the unpacked build while retaining its model cache
      // reloading through the runtime disables command-line installs in recent Chrome builds
      const cdp = await context.browser().newBrowserCDPSession();
      ({ id } = await cdp.send('Extensions.loadUnpacked', { path: extension }));
    } else {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      id = new URL(worker.url()).host;
    }
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/sidepanel.html`);
    await waitForPanel(page);
    return { context, page, id, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function waitForPanel(page) {
  await page.waitForFunction(() => document.querySelector('.bar-primary')?.disabled === false);
}
