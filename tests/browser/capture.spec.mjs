import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { openExtension, waitForPanel } from '../../scripts/browser.mjs';

let server, origin;
test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'",
    });
    response.end(
      '<!doctype html><title>Capture test page</title><style>html,body{margin:0;background:#f8e4c1}body{height:2500px}div{position:absolute;width:240px;height:120px;left:40px;top:140px;background:#207d66;border:4px solid #193b35}p{margin:12px;font:24px serif}</style><p>Region capture test</p><div></div>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(() => new Promise((resolve) => server.close(resolve)));

async function source(extension, url = origin) {
  const target = await extension.context.newPage();
  await target.setViewportSize({ width: 1000, height: 720 });
  await target.goto(url);
  const browserSession = await extension.context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', {
    filter: [{ type: 'tab' }, { exclude: true }],
  });
  const tab = targetInfos.find((info) => info.url === target.url());
  if (!tab) throw new Error('Could not locate the real browser tab target');
  await target.bringToFront();
  await browserSession.send('Extensions.triggerAction', {
    id: extension.id,
    targetId: tab.targetId,
  });
  await extension.page.evaluate(
    () =>
      new Promise((resolve) => {
        window.__capturePort = chrome.runtime.connect({ name: 'teximagescan-panel' });
        window.__capturePort.onMessage.addListener((state) => {
          window.__captureState = state;
          resolve();
        });
      }),
  );
  return target;
}
async function begin(panel, target) {
  await target.bringToFront();
  const response = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'capture-begin' }),
  );
  expect(response, response?.message).toMatchObject({ ok: true });
  await expect(target.locator('[data-teximagescan-capture]')).toBeVisible();
}
async function cropInfo(panel) {
  return panel.evaluate(async () => {
    const image = window.__captureState.input.image;
    const bitmap = await createImageBitmap(await (await fetch(image)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      center: [
        ...ctx.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data,
      ],
    };
  });
}
async function drag(target, from = { x: 40, y: 140 }, to = { x: 280, y: 260 }) {
  await target.mouse.move(from.x, from.y);
  await target.mouse.down();
  await target.mouse.move(to.x, to.y, { steps: 8 });
  await target.mouse.up();
  await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
}

async function freehand(target, points) {
  await target.mouse.move(points[0].x, points[0].y);
  await target.mouse.down();
  for (const point of points.slice(1)) await target.mouse.move(point.x, point.y, { steps: 5 });
  await target.mouse.up();
}

async function overlayControl(target, name) {
  const cdp = await target.context().newCDPSession(target);
  try {
    // Chromium exposes closed-shadow controls through the accessibility tree
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const button = nodes.find(
      (node) =>
        node.role?.value === 'button' && node.name?.value?.toLowerCase() === name.toLowerCase(),
    );
    expect(button, `Accessible overlay button: ${name}`).toBeTruthy();
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: button.backendDOMNodeId });
    const [x1, y1, x2, , , y2] = model.content;
    const viewport = await target.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(x1).toBeGreaterThanOrEqual(0);
    expect(y1).toBeGreaterThanOrEqual(0);
    expect(x2).toBeLessThanOrEqual(viewport.width);
    expect(y2).toBeLessThanOrEqual(viewport.height);
    await target.mouse.click((x1 + x2) / 2, (y1 + y2) / 2);
  } finally {
    await cdp.detach();
  }
}

async function captureToolbarLayout(target) {
  const cdp = await target.context().newCDPSession(target);
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const button = nodes.find(
      (node) => node.role?.value === 'button' && node.name?.value === 'Rectangle',
    );
    const { object } = await cdp.send('DOM.resolveNode', {
      backendNodeId: button.backendDOMNodeId,
    });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const root = this.getRootNode();
        const box = element => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        const canvas = root.querySelector('canvas');
        return { toolbar: box(root.querySelector('.instructions')),
          image: box(canvas),
          pixels: { width: canvas.width, height: canvas.height },
          controls: [...root.querySelectorAll('button')].map(box),
          hint: box(root.querySelector('.hint')),
          active: root.querySelector('button[aria-pressed="true"]').textContent };
      }`,
    });
    return result.value;
  } finally {
    await cdp.detach();
  }
}

async function pageModal(target, closedShadow = false) {
  await target.evaluate((closedShadow) => {
    let root = document.body;
    if (closedShadow) {
      const host = document.createElement('section');
      document.body.append(host);
      root = host.attachShadow({ mode: 'closed' });
    }
    const dialog = document.createElement('dialog');
    dialog.style.cssText =
      'position:fixed;left:300px;top:200px;margin:0;width:280px;height:180px;padding:0;border:0;background:#207d66';
    const button = document.createElement('button');
    button.textContent = 'Page action';
    dialog.append(button);
    root.append(dialog);
    window.__pageModal = dialog;
    dialog.showModal();
    button.focus();
  }, closedShadow);
}

for (const loseReply of [false, true])
  test(`capture can retry the same crop after ${loseReply ? 'a lost acknowledgement' : 'failed delivery'}`, async () => {
    const extension = await openExtension({ gpu: false });
    try {
      const target = await source(extension);
      const worker = extension.context.serviceWorkers()[0];
      await worker.evaluate((loseReply) => {
        const runtime = (globalThis.browser?.runtime?.id ? globalThis.browser : chrome).runtime;
        const send = runtime.sendMessage.bind(runtime);
        let failed = false;
        runtime.sendMessage = async (message, ...args) => {
          if (message?.type === 'capture-host' && message.event.type === 'capture-finished' && !failed) {
            failed = true;
            globalThis.__captureDeliveryFault = true;
            if (loseReply) await send(message, ...args);
            throw new Error('Capture delivery test failure');
          }
          return send(message, ...args);
        };
      }, loseReply);
      await begin(extension.page, target);
      await target.mouse.move(40, 140);
      await target.mouse.down();
      await target.mouse.move(280, 260, { steps: 8 });
      await target.mouse.up();
      await expect.poll(() => worker.evaluate(() => globalThis.__captureDeliveryFault)).toBe(true);
      const cdp = await target.context().newCDPSession(target);
      try {
        await expect.poll(async () => {
          const { nodes } = await cdp.send('Accessibility.getFullAXTree');
          return nodes.some((node) =>
            node.role?.value === 'button' && node.name?.value?.toLowerCase() === 'retry',
          );
        }).toBe(true);
      } finally {
        await cdp.detach();
      }
      await expect(target.locator('[data-teximagescan-capture]')).toBeVisible();
      expect(await worker.evaluate(async () =>
        Boolean((await chrome.storage.session.get('teximagescan-capture'))['teximagescan-capture']),
      )).toBe(true);
      await overlayControl(target, 'Retry');
      await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
      await expect.poll(() => extension.page.evaluate(() => window.__captureState.capture.kind))
        .toBe('idle');
      expect(await cropInfo(extension.page)).toMatchObject({
        width: 240, height: 120, center: [32, 125, 102, 255],
      });
      await begin(extension.page, target);
      await target.keyboard.press('Escape');
      await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
    } finally {
      await extension.close();
    }
  });

for (const [shape, dpr, zoom] of [
  ['rectangle', 1, 1],
  ['lasso', 2, 1.25],
]) {
  test(`capture over a modal page with ${shape} preserves pixels, focus and the page dialog`, async () => {
    const extension = await openExtension({
      gpu: false,
      extensionDebug: true,
      deviceScaleFactor: dpr,
    });
    try {
      const target = await source(extension);
      await extension.page.evaluate(async (zoom) => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await chrome.tabs.setZoom(tab.id, zoom);
      }, zoom);
      await pageModal(target);
      await begin(extension.page, target);
      const { image, pixels } = await captureToolbarLayout(target);
      const viewport = await target.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(Math.abs(image.width - viewport.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(image.height - viewport.height)).toBeLessThanOrEqual(1);
      if (shape === 'lasso') {
        await overlayControl(target, 'Lasso');
        await freehand(target, [
          { x: 340, y: 260 },
          { x: 540, y: 260 },
          { x: 540, y: 340 },
          { x: 340, y: 340 },
          { x: 340, y: 260 },
        ]);
        await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
      } else await drag(target, { x: 340, y: 260 }, { x: 540, y: 340 });
      await extension.page.waitForFunction(() => window.__captureState.input);
      const info = await cropInfo(extension.page);
      expect(Math.abs(info.width - (200 * pixels.width) / image.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(info.height - (80 * pixels.height) / image.height)).toBeLessThanOrEqual(1);
      expect(info.center).toEqual([32, 125, 102, 255]);
      expect(await target.evaluate(() => window.__pageModal.open)).toBe(true);
      await expect(target.getByRole('button', { name: 'Page action' })).toBeFocused();
      await begin(extension.page, target);
      await target.keyboard.press('Escape');
      await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
      await extension.page.waitForFunction(() => window.__captureState.capture.kind === 'idle');
      expect(await target.evaluate(() => window.__pageModal.open)).toBe(true);
      await expect(target.getByRole('button', { name: 'Page action' })).toBeFocused();
    } finally {
      await extension.close();
    }
  });
}

test('native modal cancellation removes capture over a closed-shadow page dialog', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension);
    await pageModal(target, true);
    await begin(extension.page, target);
    const cdp = await extension.context.newCDPSession(target);
    try {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      const dialog = nodes.find(
        (node) => node.role?.value === 'dialog' && node.name?.value === 'Select a region to capture',
      );
      expect(dialog).toBeTruthy();
      const { object } = await cdp.send('DOM.resolveNode', {
        backendNodeId: dialog.backendDOMNodeId,
      });
      const reply = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function () { this.requestClose(); }',
      });
      expect(reply.exceptionDetails).toBeUndefined();
    } finally {
      await cdp.detach();
    }
    await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
    await extension.page.waitForFunction(() => window.__captureState.capture.kind === 'idle');
    expect(await target.evaluate(() => window.__pageModal.open)).toBe(true);
    expect(
      await target.evaluate(
        () => [...document.fonts].filter((font) => font.family.startsWith('TexImageScan')).length,
      ),
    ).toBe(0);
  } finally {
    await extension.close();
  }
});

test('a modal opening failure releases capture resources and allows retry', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension);
    await pageModal(target);
    await extension.page.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const original = HTMLDialogElement.prototype.showModal;
          HTMLDialogElement.prototype.showModal = function () {
            HTMLDialogElement.prototype.showModal = original;
            throw new DOMException('Simulated dialog opening failure', 'InvalidStateError');
          };
        },
      });
    });
    const response = await extension.page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'capture-begin' }),
    );
    expect(response).toMatchObject({ ok: false, message: 'Simulated dialog opening failure' });
    await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
    expect(
      await target.evaluate(
        () => [...document.fonts].filter((font) => font.family.startsWith('TexImageScan')).length,
      ),
    ).toBe(0);
    expect(await target.evaluate(() => window.__pageModal.open)).toBe(true);
    await begin(extension.page, target);
    await target.keyboard.press('Escape');
    await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
  } finally {
    await extension.close();
  }
});

test('starting a new capture leaves side-panel content in place without duplicate instructions', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension),
      panel = extension.page;
    await panel.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/energy.png');
    const staged = panel.getByRole('region', { name: 'Source image', exact: true });
    await expect(staged).toBeVisible();
    const before = await staged.boundingBox();
    await target.bringToFront();
    // trigger the panel action without activating its standalone test tab
    await panel
      .getByRole('button', { name: 'Capture', exact: true })
      .evaluate((button) => button.click());
    await expect(target.locator('[data-teximagescan-capture]')).toBeVisible();
    await panel.waitForFunction(() => window.__captureState.capture.kind === 'selecting');
    await expect(
      panel.getByText(
        'Choose Rectangle or Lasso on the page and draw around the content. Escape cancels.',
      ),
    ).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Cancel capture', exact: true })).toHaveCount(0);
    const during = await staged.boundingBox();
    expect(during).toEqual(before);
    await target.keyboard.press('Escape');
    await panel.waitForFunction(() => window.__captureState.capture.kind === 'idle');
    await expect(panel.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled();
    expect(await staged.boundingBox()).toEqual(before);
  } finally {
    await extension.close();
  }
});

for (const width of [1000, 600, 480, 320]) {
  test(`capture mode switches keep toolbar and controls stationary at ${width}px`, { tag: '@style' }, async () => {
    const extension = await openExtension({ gpu: false, extensionDebug: true });
    try {
      const target = await source(extension);
      await target.setViewportSize({ width, height: 720 });
      await begin(extension.page, target);
      await target.waitForFunction(() => {
        const fonts = [...document.fonts].filter((font) => font.family.startsWith('TexImageScan'));
        return fonts.length === 2 && fonts.every((font) => font.status === 'loaded');
      });
      const initial = await captureToolbarLayout(target);
      for (const name of ['Lasso', 'Rectangle', 'Lasso', 'Rectangle']) {
        await overlayControl(target, name);
        const current = await captureToolbarLayout(target);
        expect(current.active).toBe(name);
        for (const [actual, expected] of [
          [current.toolbar, initial.toolbar],
          [current.hint, initial.hint],
          ...current.controls.map((box, index) => [box, initial.controls[index]]),
        ]) {
          for (const dimension of ['x', 'y', 'width', 'height'])
            expect(
              Math.abs(actual[dimension] - expected[dimension]),
              `${width}px ${name}: ${dimension} shifted`,
            ).toBeLessThan(0.5);
        }
      }

      await target.keyboard.press('Tab');
      await target.keyboard.press('Space');
      const keyboard = await captureToolbarLayout(target);
      expect(keyboard.active).toBe('Lasso');
      expect(keyboard.controls).toEqual(initial.controls);
      if (width === 1000 || width === 320)
        await target.screenshot({ path: `test-results/capture-toolbar-stable-${width}.png` });
      await overlayControl(target, 'Cancel');
      await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
      expect(await target.evaluate(() =>
        [...document.fonts].filter((font) => font.family.startsWith('TexImageScan')).length,
      )).toBe(0);
    } finally {
      await extension.close();
    }
  });
}

for (const [dpr, zoom] of [
  [1, 1],
  [2, 1.25],
]) {
  test(`lasso masks outside the outline opaque white with DPR ${dpr} and zoom ${zoom}`, async () => {
    const extension = await openExtension({
      gpu: false,
      extensionDebug: true,
      deviceScaleFactor: dpr,
    });
    try {
      const target = await source(extension);
      await extension.page.evaluate(async (zoom) => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await chrome.tabs.setZoom(tab.id, zoom);
      }, zoom);
      const viewport = await target.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve({ width: innerWidth, height: innerHeight })),
            ),
          ),
      );
      const screenshot = await extension.page.evaluate(async () => {
        const image = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
        const bitmap = await createImageBitmap(await (await fetch(image)).blob());
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
      });
      await begin(extension.page, target);
      await overlayControl(target, 'Lasso');
      await expect(target.locator('[data-teximagescan-capture]')).toBeVisible();
      const points = [
        { x: 160, y: 140 },
        { x: 280, y: 200 },
        { x: 160, y: 260 },
        { x: 40, y: 200 },
      ];
      if (dpr === 2) points.reverse();
      await target.mouse.move(points[0].x, points[0].y);
      await target.mouse.down();
      for (const point of points.slice(1)) await target.mouse.move(point.x, point.y, { steps: 5 });
      if (dpr === 1) await target.screenshot({ path: 'test-results/lasso-selection.png' });
      await target.mouse.up();
      await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
      await extension.page.waitForFunction(() => window.__captureState.input);
      const info = await cropInfo(extension.page);
      expect(
        Math.abs(info.width - (240 * screenshot.width) / viewport.width),
        JSON.stringify({ info, screenshot, viewport }),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(info.height - (120 * screenshot.height) / viewport.height),
        JSON.stringify({ info, screenshot, viewport }),
      ).toBeLessThanOrEqual(1);
      expect(info.center).toEqual([32, 125, 102, 255]);
      const corners = await extension.page.evaluate(async () => {
        const bitmap = await createImageBitmap(
          await (await fetch(window.__captureState.input.image)).blob(),
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return [
          [2, 2],
          [bitmap.width - 3, 2],
          [2, bitmap.height - 3],
          [bitmap.width - 3, bitmap.height - 3],
        ].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
      });
      for (const corner of corners) expect(corner).toEqual([255, 255, 255, 255]);
      await expect(extension.page.getByRole('img', { name: /Source: Page crop/ })).toBeVisible();
      if (dpr === 1)
        await extension.page.screenshot({ path: 'test-results/lasso-preview.png', fullPage: true });
      await extension.page.reload();
      await expect(
        extension.page.getByRole('heading', { name: 'What would you like to scan?' }),
      ).toBeVisible();
    } finally {
      await extension.close();
    }
  });
}

test('lasso supports keyboard modes, degenerate retry, self-intersections and rectangle switching', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension);
    await begin(extension.page, target);
    await drag(target);
    await extension.page.waitForFunction(() => window.__captureState.input);
    const previous = await extension.page.evaluate(() => window.__captureState.input);
    await begin(extension.page, target);
    await target.keyboard.press('Tab');
    await target.keyboard.press('Tab');
    await target.keyboard.press('Space');
    await freehand(target, [
      { x: 40, y: 140 },
      { x: 160, y: 200 },
      { x: 280, y: 260 },
    ]);
    await expect(target.locator('[data-teximagescan-capture]')).toBeVisible();
    expect(await extension.page.evaluate(() => window.__captureState.input)).toEqual(previous);
    for (const points of [
      [
        { x: 60, y: 160 },
        { x: 260, y: 160 },
        { x: 260, y: 240 },
        { x: 60, y: 240 },
        { x: 60, y: 160 },
        { x: 260, y: 160 },
        { x: 260, y: 240 },
        { x: 60, y: 240 },
        { x: 60, y: 160 },
      ],
      [
        { x: 40, y: 140 },
        { x: 46, y: 146 },
        { x: 46, y: 145 },
      ],
    ]) {
      await freehand(target, points);
      await expect(target.locator('[data-teximagescan-capture]')).toBeVisible();
      expect(await extension.page.evaluate(() => window.__captureState.input)).toEqual(previous);
    }
    await target.mouse.move(40, 140);
    await target.mouse.down();
    await target.mouse.move(160, 240);
    await target.keyboard.press('Tab');
    await target.keyboard.press('Enter');
    await target.mouse.up();
    await expect(target.locator('[data-teximagescan-capture]')).toBeVisible();
    expect(await extension.page.evaluate(() => window.__captureState.input)).toEqual(previous);
    await target.keyboard.press('Tab');
    await target.keyboard.press('Space');
    // a retraced outline encloses no pixels despite its large bounds
    await freehand(target, [
      { x: 40, y: 140 },
      { x: 160, y: 200 },
      { x: 280, y: 140 },
      { x: 160, y: 200 },
      { x: 40, y: 140 },
    ]);
    await expect(target.locator('[data-teximagescan-capture]')).toBeVisible();
    expect(await extension.page.evaluate(() => window.__captureState.input)).toEqual(previous);
    // overlapping circuits create a hole under the even-odd fill rule
    await freehand(target, [
      { x: 60, y: 160 },
      { x: 260, y: 160 },
      { x: 260, y: 240 },
      { x: 60, y: 240 },
      { x: 60, y: 160 },
      { x: 100, y: 180 },
      { x: 220, y: 180 },
      { x: 220, y: 220 },
      { x: 100, y: 220 },
      { x: 100, y: 180 },
      { x: 60, y: 160 },
    ]);
    await extension.page.waitForFunction(
      (id) => window.__captureState.input.id !== id,
      previous.id,
    );
    expect((await cropInfo(extension.page)).center).toEqual([255, 255, 255, 255]);
    await begin(extension.page, target);
    await overlayControl(target, 'Lasso');
    await overlayControl(target, 'Rectangle');
    await drag(target);
    await extension.page.waitForFunction(() => window.__captureState.capture.kind === 'idle');
    expect((await cropInfo(extension.page)).center).toEqual([32, 125, 102, 255]);
    await begin(extension.page, target);
    await target.keyboard.press('Shift+Tab');
    await target.keyboard.press('Enter');
    await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
  } finally {
    await extension.close();
  }
});

test('lasso controls fit a narrow viewport and Escape preserves the previous crop', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension);
    await target.setViewportSize({ width: 340, height: 720 });
    await begin(extension.page, target);
    await overlayControl(target, 'Lasso');
    await freehand(target, [
      { x: 160, y: 240 },
      { x: 280, y: 300 },
      { x: 160, y: 360 },
      { x: 40, y: 300 },
    ]);
    await extension.page.waitForFunction(() => window.__captureState.input);
    expect((await cropInfo(extension.page)).center).toEqual([248, 228, 193, 255]);
    const previous = await extension.page.evaluate(() => window.__captureState.input);
    await begin(extension.page, target);
    await overlayControl(target, 'Lasso');
    await target.screenshot({ path: 'test-results/lasso-narrow.png' });
    await target.keyboard.press('Escape');
    await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
    expect(await extension.page.evaluate(() => window.__captureState.input)).toEqual(previous);
  } finally {
    await extension.close();
  }
});

test('captures original pixels without overlay, stages preview, and opens a fresh panel after reload', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension);
    await begin(extension.page, target);
    await drag(target);
    await extension.page.waitForFunction(() =>
      window.__captureState.input?.name.startsWith('Page crop'),
    );
    const input = await extension.page.evaluate(() => window.__captureState.input);
    const pixels = await extension.page.evaluate(async (image) => {
      const bitmap = await createImageBitmap(await (await fetch(image)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return {
        width: bitmap.width,
        height: bitmap.height,
        center: [
          ...ctx.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1)
            .data,
        ],
      };
    }, input.image);
    expect(pixels.width).toBe(240);
    expect(pixels.height).toBe(120);
    expect(pixels.center).toEqual([32, 125, 102, 255]);
    await expect(extension.page.getByRole('img', { name: /Source: Page crop/ })).toBeVisible();
    expect(await extension.page.evaluate(() => window.__captureState.job.kind)).toBe('idle');
    await extension.page.reload();
    await expect(
      extension.page.getByRole('heading', { name: 'What would you like to scan?' }),
    ).toBeVisible();
  } finally {
    await extension.close();
  }
});

test('Escape and reverse drag work without overwriting the previous source', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension);
    await begin(extension.page, target);
    await drag(target, { x: 280, y: 260 }, { x: 40, y: 140 });
    await extension.page.waitForFunction(() => window.__captureState.input);
    const previous = await extension.page.evaluate(() => window.__captureState.input);
    await begin(extension.page, target);
    await target.keyboard.press('Escape');
    await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
    await extension.page.waitForFunction(() => window.__captureState.capture.kind === 'idle');
    expect(await extension.page.evaluate(() => window.__captureState.input)).toEqual(previous);
  } finally {
    await extension.close();
  }
});

test('Escape in the side panel cancels capture and preserves the previous source', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension);
    const panel = extension.page;
    await panel.getByLabel('Choose image file').setInputFiles('tests/fixtures/samples/energy.png');
    await panel.waitForFunction(() => window.__captureState.input?.name === 'energy.png');
    const previous = await panel.evaluate(() => window.__captureState.input);
    await target.bringToFront();
    await panel
      .getByRole('button', { name: 'Capture', exact: true })
      .evaluate((button) => button.click());
    await expect(target.locator('[data-teximagescan-capture]')).toBeVisible();
    await panel.waitForFunction(() => window.__captureState.capture.kind === 'selecting');
    // deliver the key to the panel, where focus can remain after clicking Capture
    // activating its standalone test tab would instead cancel through tab switching
    await panel.keyboard.press('Escape');
    await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
    await panel.waitForFunction(() => window.__captureState.capture.kind === 'idle');
    expect(await panel.evaluate(() => window.__captureState.input)).toEqual(previous);
    await expect(panel.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled();
    await begin(panel, target);
    await target.keyboard.press('Escape');
    await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
  } finally {
    await extension.close();
  }
});

test('capture without a tab grant shows concise access guidance', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    await extension.page.bringToFront();
    await extension.page.getByRole('button', { name: 'Capture', exact: true }).click();
    await expect(
      extension.page.getByRole('status').filter({ hasText: 'Click the TexImageScan toolbar icon' }),
    ).toBeVisible();
    await expect(extension.page.getByRole('alert')).toHaveCount(0);
    await extension.page.getByRole('button', { name: 'Capture settings', exact: true }).click();
    await expect(
      extension.page.getByRole('checkbox', { name: 'Capture across tabs', exact: true }),
    ).toBeVisible();
    await expect(
      extension.page.getByRole('button', { name: 'Capture', exact: true }),
    ).toBeEnabled();
  } finally {
    await extension.close();
  }
});

async function screenshotEditor(extension, target) {
  await target.bringToFront();
  const opened = extension.context.waitForEvent('page');
  void opened.catch(() => undefined);
  const response = await extension.page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'capture-begin' }),
  );
  expect(response, response?.message).toMatchObject({ ok: true });
  const editor = await opened;
  await editor.waitForURL('**/capture-editor.html#*');
  await expect(editor.locator('[data-teximagescan-capture]')).toBeVisible();
  return editor;
}

async function screenshotCount(panel) {
  return panel.evaluate(async () => {
    const request = indexedDB.open('teximagescan-capture');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = reject;
    });
    const count = await new Promise((resolve, reject) => {
      const request = db.transaction('screenshots').objectStore('screenshots').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = reject;
    });
    db.close();
    return count;
  });
}

test('cancelling startup releases a pending viewport request and ignores its late reply', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  const worker = extension.context.serviceWorkers()[0];
  try {
    const target = await source(extension);
    await worker.evaluate(() => {
      const send = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (...args) => {
        if (args[1]?.type === 'capture-viewport' && !globalThis.__capturePaused) {
          globalThis.__capturePaused = true;
          return new Promise((resolve) => {
            globalThis.__resumeCapture = () => {
              const reply = send(...args);
              resolve(reply);
              return reply;
            };
          });
        }
        return send(...args);
      };
    });
    const response = extension.page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'capture-begin' }),
    );
    await expect.poll(() => worker.evaluate(() => globalThis.__capturePaused)).toBe(true);
    expect(await extension.page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'capture-cancel' }),
    )).toMatchObject({ ok: true });
    expect(await response).toMatchObject({ ok: false });
    await begin(extension.page, target);
    const id = await extension.page.evaluate(() => window.__captureState.capture.id);
    await worker.evaluate(() => globalThis.__resumeCapture());
    await expect(target.locator('[data-teximagescan-capture]')).toBeVisible();
    expect(await extension.page.evaluate(() => window.__captureState.capture.id)).toBe(id);
    await target.keyboard.press('Escape');
    await extension.page.waitForFunction(() => window.__captureState.capture.kind === 'idle');
  } finally {
    await worker.evaluate(() => globalThis.__resumeCapture?.()).catch(() => undefined);
    await extension.close();
  }
});

test('source navigation while screenshot selection is opening discards the pending screenshot', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  const worker = extension.context.serviceWorkers()[0];
  try {
    const target = await source(extension, 'chrome://version');
    // pause tab creation at the API boundary without replacing its result
    await worker.evaluate(() => {
      const create = chrome.tabs.create.bind(chrome.tabs);
      chrome.tabs.create = async (options) => {
        if (options.url === 'about:blank')
          await new Promise((resolve) => {
            globalThis.__resumeCapture = resolve;
            globalThis.__capturePaused = true;
          });
        return create(options);
      };
    });
    const response = extension.page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'capture-begin' }),
    );
    void response.catch(() => undefined);
    await expect.poll(() => worker.evaluate(() => globalThis.__capturePaused)).toBe(true);
    await target.goto('chrome://credits');
    await worker.evaluate(() => globalThis.__resumeCapture());
    expect(await response).toMatchObject({ ok: false });
    expect(await screenshotCount(extension.page)).toBe(0);
    expect(
      extension.context.pages().some((page) => page.url().includes('/capture-editor.html')),
    ).toBe(false);
  } finally {
    await worker.evaluate(() => globalThis.__resumeCapture?.()).catch(() => undefined);
    await extension.close();
  }
});

test('a restarted controller removes a screenshot with no owning session', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    await extension.page.evaluate(async () => {
      const request = indexedDB.open('teximagescan-capture', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('screenshots');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
      const tx = db.transaction('screenshots', 'readwrite');
      tx.objectStore('screenshots').put(
        { id: 'orphan', name: 'Old screenshot', screenshot: 'data:image/png;base64,b2xk' },
        'orphan',
      );
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
      db.close();
    });
    const cdp = await extension.context.newCDPSession(extension.page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.detach();
    await extension.page.evaluate(() => chrome.runtime.sendMessage({ type: 'capture-cancel' }));
    expect(await screenshotCount(extension.page)).toBe(0);
  } finally {
    await extension.close();
  }
});

for (const dpr of [1, 2])
  test(`a protected Chrome page opens screenshot selection and returns original pixels at DPR ${dpr}`, async () => {
    const extension = await openExtension({
      gpu: false,
      extensionDebug: true,
      deviceScaleFactor: dpr,
    });
    try {
      const target = await source(extension, 'chrome://version');
      const editor = await screenshotEditor(extension, target);
      await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);

      const id = new URL(editor.url()).hash.slice(1);
      const pixels = await editor.evaluate(async (id) => {
        const reply = await chrome.runtime.sendMessage({ type: 'capture-image-get', id });
        const bitmap = await createImageBitmap(
          await (await fetch(reply.snapshot.screenshot)).blob(),
        );
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
      }, id);
      expect(
        await extension.page.evaluate(
          (id) => chrome.runtime.sendMessage({ type: 'capture-image-get', id }),
          id,
        ),
      ).toMatchObject({ ok: false });
      expect(
        await extension.page.evaluate(
          (id) =>
            chrome.runtime.sendMessage({
              type: 'capture-image-result',
              event: { type: 'capture-cancelled', id },
            }),
          id,
        ),
      ).toMatchObject({ ok: false });
      if (dpr === 1) {
        const cdp = await extension.context.newCDPSession(extension.page);
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        await cdp.detach();
        expect(
          await editor.evaluate(
            (id) => chrome.runtime.sendMessage({ type: 'capture-image-get', id }),
            id,
          ),
        ).toMatchObject({ ok: true });
      }
      const { image } = await captureToolbarLayout(editor);
      expect(image.width / image.height).toBeCloseTo(1000 / 720, 4);
      const closed = editor.waitForEvent('close');
      await editor.mouse.move(image.x + image.width * 0.2, image.y + image.height * 0.3);
      await editor.mouse.down();
      await editor.mouse.move(image.x + image.width * 0.4, image.y + image.height * 0.5, {
        steps: 6,
      });
      await editor.mouse.up();
      await closed;
      await extension.page.waitForFunction(() =>
        window.__captureState.input?.name.startsWith('Page crop'),
      );
      const info = await cropInfo(extension.page);
      expect(Math.abs(info.width - pixels.width * 0.2)).toBeLessThanOrEqual(1);
      expect(Math.abs(info.height - pixels.height * 0.2)).toBeLessThanOrEqual(1);
      expect(await target.evaluate(() => document.visibilityState)).toBe('visible');
      expect(await screenshotCount(extension.page)).toBe(0);
    } finally {
      await extension.close();
    }
  });

for (const ending of [
  'Escape',
  'close',
  'switch tab',
  'source navigation',
  'source close',
  'editor navigation',
])
  test(`screenshot selection preserves the previous input and deletes temporary pixels on ${ending}`, async () => {
    const extension = await openExtension({ gpu: false, extensionDebug: true });
    try {
      const target = await source(extension, 'chrome://version');
      await extension.page
        .getByLabel('Choose image file')
        .setInputFiles('tests/fixtures/samples/energy.png');
      await extension.page.waitForFunction(
        () => window.__captureState.input?.name === 'energy.png',
      );
      const previous = await extension.page.evaluate(() => window.__captureState.input);
      const editor = await screenshotEditor(extension, target);
      expect(await screenshotCount(extension.page)).toBe(1);
      if (ending === 'Escape') await editor.keyboard.press('Escape');
      else if (ending === 'close') await editor.close();
      else if (ending === 'switch tab') await target.bringToFront();
      else if (ending === 'source navigation') await target.goto('chrome://credits');
      else if (ending === 'source close') await target.close();
      else await editor.goto(origin);
      if (ending === 'editor navigation') {
        await expect(editor).toHaveURL(origin + '/');
        expect(editor.isClosed()).toBe(false);
      } else await expect.poll(() => editor.isClosed()).toBe(true);
      await extension.page.waitForFunction(() => window.__captureState.capture.kind === 'idle');
      expect(await extension.page.evaluate(() => window.__captureState.input)).toEqual(previous);
      expect(await screenshotCount(extension.page)).toBe(0);
    } finally {
      await extension.close();
    }
  });

test('expired screenshot selection reports timeout and releases its temporary image', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension, 'chrome://version');
    const editor = await screenshotEditor(extension, target);
    await extension.page.evaluate(async () => {
      const key = 'teximagescan-capture';
      const value = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.set({ [key]: { ...value, startedAt: Date.now() - 126_000 } });
    });
    await editor.keyboard.press('Escape');
    await expect.poll(() => editor.isClosed()).toBe(true);
    await expect(extension.page.getByRole('alert')).toContainText('Capture timed out');
    expect(await screenshotCount(extension.page)).toBe(0);
  } finally {
    await extension.close();
  }
});

test('screenshot selection supports Lasso in a narrow editor', async () => {
  const extension = await openExtension({
    gpu: false,
    extensionDebug: true,
    viewport: { width: 320, height: 720 },
  });
  try {
    const target = await source(extension, 'chrome://version');
    const narrow = await screenshotEditor(extension, target);
    await overlayControl(narrow, 'Lasso');
    const { image } = await captureToolbarLayout(narrow);
    await narrow.screenshot({ path: 'test-results/screenshot-selection.png' });
    await freehand(narrow, [
      { x: image.x + image.width * 0.2, y: image.y + image.height * 0.3 },
      { x: image.x + image.width * 0.4, y: image.y + image.height * 0.3 },
      { x: image.x + image.width * 0.4, y: image.y + image.height * 0.5 },
      { x: image.x + image.width * 0.2, y: image.y + image.height * 0.3 },
    ]);
    await expect.poll(() => narrow.isClosed()).toBe(true);
    await extension.page.waitForFunction(() => window.__captureState.input);
    const info = await cropInfo(extension.page);
    expect(Math.abs(info.width - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs(info.height - 144)).toBeLessThanOrEqual(1);
    expect(await screenshotCount(extension.page)).toBe(0);
  } finally {
    await extension.close();
  }
});

for (const [dpr, zoom] of [
  [1.5, 1],
  [2, 1.25],
  [1, 0.8],
]) {
  test(`crop geometry remains correct with DPR ${dpr} and browser zoom ${zoom}`, async () => {
    const extension = await openExtension({
      gpu: false,
      extensionDebug: true,
      deviceScaleFactor: dpr,
    });
    try {
      const target = await source(extension);
      await extension.page.evaluate(async (zoom) => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await chrome.tabs.setZoom(tab.id, zoom);
      }, zoom);
      const viewport = await target.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve({ width: innerWidth, height: innerHeight })),
            ),
          ),
      );
      const screenshot = await extension.page.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const bitmap = await createImageBitmap(await (await fetch(image)).blob());
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
      });
      await begin(extension.page, target);
      await drag(target);
      await extension.page.waitForFunction(() => window.__captureState.input);
      const info = await cropInfo(extension.page);
      expect(Math.abs(info.width - (240 * screenshot.width) / viewport.width)).toBeLessThanOrEqual(
        1,
      );
      expect(
        Math.abs(info.height - (120 * screenshot.height) / viewport.height),
      ).toBeLessThanOrEqual(1);
      expect(info.center).toEqual([32, 125, 102, 255]);
    } finally {
      await extension.close();
    }
  });
}

test('scroll offset and service-worker restart do not corrupt a crop', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension);
    await target.evaluate(() => {
      document.querySelector('div').style.top = '1140px';
      scrollTo(0, 1000);
    });
    await begin(extension.page, target);
    const cdp = await extension.context.newCDPSession(extension.page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await drag(target);
    await extension.page.waitForFunction(() => window.__captureState.input);
    expect((await cropInfo(extension.page)).center).toEqual([32, 125, 102, 255]);
  } finally {
    await extension.close();
  }
});

test('expired selections clear the host and keyboard Cancel remains usable', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension);
    await begin(extension.page, target);
    await extension.page.evaluate(async () => {
      const key = 'teximagescan-capture';
      const stored = await chrome.storage.session.get(key);
      stored[key].startedAt = Date.now() - 130_000;
      await chrome.storage.session.set(stored);
    });
    await target.keyboard.press('Escape');
    await extension.page.waitForFunction(() => window.__captureState.capture.kind === 'failed');
    await expect(extension.page.getByRole('alert')).toContainText('timed out');
    await begin(extension.page, target);
    await target.keyboard.press('Shift+Tab');
    await target.keyboard.press('Enter');
    await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
    await extension.page.waitForFunction(() => window.__captureState.capture.kind === 'idle');
  } finally {
    await extension.close();
  }
});

test('cancelling while bitmap decoding is pending never mounts a stale overlay', async () => {
  const extension = await openExtension({ gpu: false, extensionDebug: true });
  try {
    const target = await source(extension);
    await extension.page.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const original = createImageBitmap;
          globalThis.createImageBitmap = async (...args) => {
            await new Promise((resolve) => {
              globalThis.releaseCaptureDecode = resolve;
            });
            globalThis.createImageBitmap = original;
            return original(...args);
          };
        },
      });
    });
    const starting = extension.page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'capture-begin' }),
    );
    await extension.page.waitForFunction(() => window.__captureState.capture.kind === 'selecting');
    // wait for the decoder wrapper instead of a timer
    await expect
      .poll(() =>
        extension.page.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => typeof globalThis.releaseCaptureDecode === 'function',
          });
          return result.result;
        }),
      )
      .toBe(true);
    await extension.page.evaluate(() => chrome.runtime.sendMessage({ type: 'capture-cancel' }));
    await extension.page.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => globalThis.releaseCaptureDecode(),
      });
    });
    await starting;
    await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
    await extension.page.waitForFunction(() => window.__captureState.capture.kind === 'idle');
    await begin(extension.page, target);
    await target.keyboard.press('Escape');
  } finally {
    await extension.close();
  }
});

for (const selecting of [false, true]) {
  test(`capture cleanup tolerates a missing runtime with ${selecting ? 'an active' : 'a completed'} capture`, async () => {
    const extension = await openExtension({ gpu: false, extensionDebug: true });
    try {
      const target = await source(extension);
      await begin(extension.page, target);
      if (!selecting) await drag(target);
      const [result] = await extension.page.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // remove the runtime from the script world to reproduce invalidation
            const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
            const descriptor = Object.getOwnPropertyDescriptor(api, 'runtime');
            const cleanup = globalThis.__texImageScanCaptureCleanup;
            Object.defineProperty(api, 'runtime', { value: undefined, configurable: true });
            try {
              cleanup();
              cleanup();
              return { ok: true };
            } catch (error) {
              return { ok: false, message: error.message };
            } finally {
              Object.defineProperty(api, 'runtime', descriptor);
            }
          },
        });
      });
      expect(result.result).toEqual({ ok: true });
      await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
      expect(
        await target.evaluate(
          () => [...document.fonts].filter((font) => font.family.startsWith('TexImageScan')).length,
        ),
      ).toBe(0);
      await begin(extension.page, target);
      await target.keyboard.press('Escape');
      await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(0);
    } finally {
      await extension.close();
    }
  });

  test(`extension reload keeps the page usable with ${selecting ? 'an active' : 'a completed'} capture`, async () => {
    const extension = await openExtension({ gpu: false, extensionDebug: true });
    try {
      const manager = await extension.context.newPage();
      await manager.goto('chrome://extensions');
      // match a user-installed unpacked extension because CLI loading bypasses this setting
      const configuration = await manager.evaluate(() => {
        chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
        return new Promise((resolve) => chrome.developerPrivate.getProfileConfiguration(resolve));
      });
      expect(configuration.inDeveloperMode).toBe(true);
      const target = await source(extension);
      const errors = [];
      target.on('pageerror', (error) => errors.push(error.message));
      const documentId = await target.evaluate(() => {
        window.__captureReloadDocument = crypto.randomUUID();
        return window.__captureReloadDocument;
      });
      await begin(extension.page, target);
      if (!selecting) {
        await drag(target);
        await extension.page.waitForFunction(() => window.__captureState.input);
      }

      // reload without navigating the page or discarding the previous script
      const cdp = await extension.context.browser().newBrowserCDPSession();
      await manager.evaluate(
        (id) =>
          new Promise((resolve, reject) => {
            chrome.developerPrivate.reload(id, { failQuietly: true }, () => {
              const error = chrome.runtime.lastError;
              if (error) reject(new Error(error.message));
              else resolve();
            });
          }),
        extension.id,
      );
      extension.page = await extension.context.newPage();
      await extension.page.goto(`chrome-extension://${extension.id}/sidepanel.html`);
      await waitForPanel(extension.page);
      await target.setViewportSize({ width: 1000, height: 720 });
      await target.bringToFront();
      const { targetInfos } = await cdp.send('Target.getTargets', {
        filter: [{ type: 'tab' }, { exclude: true }],
      });
      const tab = targetInfos.find((info) => info.url === target.url());
      await cdp.send('Extensions.triggerAction', { id: extension.id, targetId: tab.targetId });
      await extension.page.evaluate(
        () =>
          new Promise((resolve) => {
            window.__capturePort = chrome.runtime.connect({ name: 'teximagescan-panel' });
            window.__capturePort.onMessage.addListener((state) => {
              window.__captureState = state;
              resolve();
            });
          }),
      );

      await begin(extension.page, target);
      await expect(target.locator('[data-teximagescan-capture]')).toHaveCount(1);
      await drag(target);
      await extension.page.waitForFunction(
        () => window.__captureState.capture.kind === 'idle' && window.__captureState.input,
      );
      expect(errors).toEqual([]);
      const crop = await cropInfo(extension.page);
      expect(crop.width).toBeGreaterThan(0);
      expect(crop.height).toBeGreaterThan(0);
      expect(await target.evaluate(() => window.__captureReloadDocument)).toBe(documentId);
    } finally {
      await extension.close();
    }
  });
}

test('capture shortcut is registered in Chrome', async () => {
  const extension = await openExtension({ gpu: false });
  try {
    const commands = await extension.page.evaluate(() => chrome.commands.getAll());
    // Chromium browsers localize and reorder modifiers on German Windows
    const shortcut = commands.find((command) => command.name === 'capture-area')?.shortcut;
    expect(shortcut).toBeTruthy();
    const keys = shortcut.split('+');
    expect(keys).toHaveLength(3);
    expect(keys).toContain('Alt');
    expect(keys).toContain('S');
    expect(keys.some((key) => /shift|umschalt/i.test(key))).toBe(true);
  } finally {
    await extension.close();
  }
});
