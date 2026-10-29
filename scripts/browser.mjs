import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';

export function browserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA,
      'C:/Program Files', 'C:/Program Files (x86)'].filter(Boolean)
      .map((root) => join(root, 'Google/Chrome/Application/chrome.exe')),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    chromium.executablePath(),
  ];
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
  gpu = false,
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
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--enable-unsafe-extension-debugging',
      ...(gpu ? ['--enable-unsafe-webgpu'] : []),
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
    // Chrome requires CDP to load unpacked extensions
    // reloading the build keeps the profile's model cache
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    await cdp.detach();
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
