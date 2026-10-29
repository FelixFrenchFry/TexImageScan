import { expect } from '@playwright/test';

export async function openSettings(page) {
  if (!(await page.getByRole('region', { name: 'Settings', exact: true }).isVisible())) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
  await page.getByRole('combobox', { name: 'Output token limit', exact: true }).waitFor();
}
export async function openHistory(page) {
  if (!(await page.getByRole('region', { name: 'Scan history', exact: true }).isVisible())) {
    await page.getByRole('button', { name: 'Scan history', exact: true }).click();
  }
  await page.getByRole('region', { name: 'Scan history', exact: true }).waitFor();
}
export async function openSavedScan(page, name, id) {
  await openHistory(page);
  if (id !== undefined) {
    const readState = () =>
      page.evaluate(() =>
        new Promise((resolve, reject) => {
          const port = chrome.runtime.connect({ name: 'teximagescan-panel' });
          port.onDisconnect.addListener(() =>
            reject(new Error('The local host disconnected while opening the scan.')),
          );
          port.onMessage.addListener((state) => {
            resolve({ ids: state.history.map((entry) => entry.id), resultId: state.result?.id });
            port.disconnect();
          });
        }),
      );
    const index = (await readState()).ids.indexOf(id);
    if (index < 0) throw new Error('This scan is no longer available.');
    const rows = page.locator('.history-list li');
    while ((await rows.count()) <= index) {
      const visible = await rows.count();
      await page.getByRole('button', { name: 'Show more scans', exact: true }).click();
      await expect.poll(() => rows.count()).toBeGreaterThan(visible);
    }
    const row = rows.nth(index);
    await row.getByRole('button', { name: `Open ${name}`, exact: true }).click();
    await expect(row).toHaveClass('active');
    await expect.poll(async () => (await readState()).resultId).toBe(id);
  } else {
    await page
      .getByRole('button', { name: `Open ${name}`, exact: true })
      .first()
      .click();
  }
  await page.getByRole('img', { name: `Source: ${name}`, exact: true }).waitFor();
}
export async function backToScan(page) {
  const back = page.getByRole('button', { name: 'Back to scan', exact: true });
  if (await back.isVisible()) {
    // a new input can navigate to Scan while this click is pending
    try {
      await back.click({ timeout: 1500 });
    } catch (error) {
      if (await back.isVisible()) throw error;
    }
  }
}
export async function editSource(page) {
  await backToScan(page);
  const field = page.getByLabel('Editable source');
  if (!(await field.isVisible()))
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
  await field.waitFor();
}
export async function startRecognition(page) {
  await backToScan(page);
  const staged = page.getByRole('button', { name: 'Recognize image', exact: true });
  if (await staged.isVisible()) await staged.click();
  else {
    const details = page.locator('.scan-details');
    if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
    await page.getByRole('button', { name: 'Recognize again', exact: true }).click();
  }
}
