import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { openExtension } from '../../scripts/browser.mjs';

let server, origin;
test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Capture access test</title><p>Capture this page</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(
  () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
);

async function setting(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: 'Capture across tabs', exact: true });
  await expect(checkbox).toBeEnabled();
  return checkbox;
}

test('first-use setup recommends cross-tab capture without requesting permission automatically', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await page.evaluate(() => {
      window.__setupRequests = 0;
      chrome.permissions.request = async () => {
        window.__setupRequests++;
        return false;
      };
    });
    const setup = page.getByRole('region', { name: 'Capture setup', exact: true });
    await expect(setup).toBeVisible();
    await expect(
      setup.getByRole('button', { name: 'Enable across tabs', exact: true }),
    ).toBeEnabled();
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/capture-first-use.png' });
    expect(await page.evaluate(() => window.__setupRequests)).toBe(0);
    expect(
      await page.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] })),
    ).toBe(false);
    await setup.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(setup).toHaveCount(0);
    await page.reload();
    await expect(setup).toHaveCount(0);
    await expect(await setting(page)).not.toBeChecked();
  } finally {
    await extension.close();
  }
});

test('declining first-use permission keeps access off and does not repeat setup', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    await page.evaluate(() => {
      chrome.permissions.request = async () => {
        window.__setupGesture = navigator.userActivation.isActive;
        return false;
      };
    });
    await page.getByRole('button', { name: 'Enable across tabs', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Capture setup', exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('status').filter({ hasText: 'Access was not enabled' }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.__setupGesture)).toBe(true);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Capture setup', exact: true })).toHaveCount(0);
    await expect(await setting(page)).not.toBeChecked();
  } finally {
    await extension.close();
  }
});

test('accepting first-use permission enables cross-tab capture and remembers completion', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const { page } = extension;
    await expect(page.getByRole('region', { name: 'Capture setup', exact: true })).toBeVisible();
    const manager = await extension.context.newPage();
    await manager.goto('chrome://extensions');
    await manager.evaluate(
      (id) =>
        new Promise((resolve, reject) => {
          chrome.developerPrivate.addHostPermission(id, '<all_urls>', () => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve();
          });
        }),
      extension.id,
    );
    await page.getByRole('button', { name: 'Enable across tabs', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Capture setup', exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await chrome.storage.local.get('captureAcrossTabsSetupComplete'))
              .captureAcrossTabsSetupComplete,
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] })),
    ).toBe(true);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Capture setup', exact: true })).toHaveCount(0);
    await expect(await setting(page)).toBeChecked();
  } finally {
    await extension.close();
  }
});

test('capture across tabs is opt-in and denial keeps the setting off', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const { page } = extension;
    // browser permission dialogs are outside page automation
    // verify a denied request still carries the click gesture
    await page.evaluate(() => {
      window.__capturePermissionRequests = [];
      chrome.permissions.request = async (options) => {
        window.__capturePermissionRequests.push({
          options,
          userGesture: navigator.userActivation.isActive,
        });
        return false;
      };
    });
    const checkbox = await setting(page);
    await expect(checkbox).not.toBeChecked();
    expect(await page.evaluate(() => window.__capturePermissionRequests)).toEqual([]);
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
    await expect(
      page.getByRole('status').filter({ hasText: 'Access was not enabled' }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.__capturePermissionRequests)).toEqual([
      { options: { origins: ['<all_urls>'] }, userGesture: true },
    ]);
    expect(
      await page.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] })),
    ).toBe(false);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await extension.close();
  }
});

test('Chrome-granted access enables capture on another tab and can be removed', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const { page } = extension;
    let checkbox = await setting(page);
    await expect(checkbox).not.toBeChecked();
    const manager = await extension.context.newPage();
    await manager.goto('chrome://extensions');
    // record prior approval through Chrome permission management
    // the permission request then runs without a native dialog
    await manager.evaluate(
      (id) =>
        new Promise((resolve, reject) => {
          chrome.developerPrivate.addHostPermission(id, '<all_urls>', () => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve();
          });
        }),
      extension.id,
    );
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    expect(
      await page.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] })),
    ).toBe(true);
    await page.reload();
    checkbox = await setting(page);
    await expect(checkbox).toBeChecked();
    // permission changes outside Settings must update the checkbox
    await page.evaluate(() => chrome.permissions.remove({ origins: ['<all_urls>'] }));
    await expect(checkbox).not.toBeChecked();
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    const target = await extension.context.newPage();
    await target.goto(origin);
    await target.bringToFront();

    await page
      .getByRole('button', { name: 'Capture', exact: true })
      .evaluate((button) => button.click());
    await expect(target.locator('[data-teximagescan-capture]')).toBeVisible();
    await target.keyboard.press('Escape');
    await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
    checkbox = await setting(page);
    await expect(checkbox).toBeEnabled();
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
    expect(
      await page.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] })),
    ).toBe(false);
    expect(
      await page.evaluate(() =>
        chrome.permissions.contains({ origins: ['https://huggingface.co/*'] }),
      ),
    ).toBe(true);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Capture setup', exact: true })).toHaveCount(0);
    await expect(await setting(page)).not.toBeChecked();
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/capture-access-settings.png' });
  } finally {
    await extension.close();
  }
});
