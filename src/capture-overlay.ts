import {
  capturePixelRect,
  selectionRect,
  lassoRect,
  fitImageRect,
  type CaptureViewport,
  type Point,
} from './capture';
import { MAX_IMAGE_BYTES, type CaptureEvent } from './protocol';
import geistSans from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline';
import geistMono from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?inline';

const captureHints = {
  rectangle: 'Drag to select. Esc cancels.',
  lasso: 'Draw a loop. Esc cancels.',
};

export async function mountCaptureOverlay({
  id,
  screenshot,
  viewport,
  finish,
  signal: cancellation,
  fitImage = false,
  name,
}: {
  id: string;
  screenshot: string;
  viewport: CaptureViewport;
  finish: (event: CaptureEvent) => Promise<void>;
  signal: AbortSignal;
  fitImage?: boolean;
  name?: string;
}): Promise<() => void> {
  const matchesViewport = () =>
    innerWidth === viewport.width &&
    innerHeight === viewport.height &&
    scrollX === viewport.scrollX &&
    scrollY === viewport.scrollY &&
    Math.abs((visualViewport?.scale ?? 1) - viewport.scale) < 0.001;
  if (!matchesViewport()) throw new Error('The page moved during capture. Capture the area again.');
  const encoded = atob(screenshot.slice(screenshot.indexOf(',') + 1));
  const bytes = Uint8Array.from(encoded, (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  if (cancellation.aborted) {
    bitmap.close();
    throw new DOMException('Capture cancelled', 'AbortError');
  }
  if (!matchesViewport()) {
    bitmap.close();
    throw new Error('The page moved during capture. Capture the area again.');
  }
  const imageRect = fitImage
    ? fitImageRect(bitmap, viewport)
    : { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const host = document.createElement('div');
  host.setAttribute('data-teximagescan-capture', id);
  host.style.cssText =
    'all:initial!important;position:fixed!important;inset:0!important;display:block!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;isolation:isolate!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    *{box-sizing:border-box} .surface{position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:hidden;cursor:crosshair;touch-action:none;user-select:none;color:#0A0A0A;font:13px/1.5 'TexImageScan Sans',system-ui,sans-serif;outline:none;color-scheme:light}
    .surface::backdrop{background:transparent}
    canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
    .outline{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
    .instructions{position:absolute;left:50%;top:12px;transform:translateX(-50%);display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;width:400px;max-width:calc(100% - 16px);padding:6px 8px;border:1.5px solid #0A0A0A;border-radius:0;background:#fff;cursor:default}
    .modes{display:flex;justify-self:start;border:1.5px solid #0A0A0A} .hint{display:grid;min-width:0;max-width:320px;color:#525252}
    .hint::before,.hint::after,.hint-text{grid-area:1/1} .hint::before,.hint::after{visibility:hidden;pointer-events:none}
    .hint::before{content:attr(data-rectangle-hint)} .hint::after{content:attr(data-lasso-hint)}
    button{min-height:30px;font:600 13px/1.4 'TexImageScan Sans',system-ui,sans-serif;background:#fff;color:#0A0A0A;border:0;border-radius:0;padding:5px 8px;cursor:pointer}
    .modes button+button{border-left:1.5px solid #0A0A0A} button[aria-pressed="true"]{background:#0E5F55;color:#fff} button[aria-pressed="false"]:hover{background:#F5F5F4} button[aria-pressed="true"]:hover{background:#0B4D45}
    .actions{display:flex;align-items:center;gap:8px} .cancel{padding:0;background:transparent;font:500 11px/1.4 'TexImageScan Mono',ui-monospace,monospace;letter-spacing:.04em;text-transform:uppercase;text-decoration:underline;text-underline-offset:3px} .cancel:hover{color:#0E5F55}
    button:focus-visible{outline:2px solid #0E5F55;outline-offset:3px} .modes button:focus-visible{outline-offset:-4px;outline-color:currentColor}
    @media(pointer:coarse){button{min-height:44px}} @media(max-width:380px){.instructions{grid-template-columns:1fr auto;gap:4px 8px}.hint{grid-column:1/-1;grid-row:2;max-width:none;width:100%;text-align:center}}
  `);
  shadow.adoptedStyleSheets = [sheet];
  const surface = document.createElement('dialog');
  surface.className = 'surface';
  surface.tabIndex = -1;
  if (fitImage) surface.style.background = '#525252';
  surface.setAttribute('role', 'dialog');
  surface.setAttribute('aria-label', 'Select a region to capture');
  surface.setAttribute('aria-modal', 'true');
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error('Image capture is unavailable.');
  }
  context.drawImage(bitmap, 0, 0);
  // binary font sources avoid page font restrictions and external requests
  const fonts = [
    { family: 'TexImageScan Sans', data: geistSans },
    { family: 'TexImageScan Mono', data: geistMono },
  ].map(({ family, data }) => {
    const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), (character) =>
      character.charCodeAt(0),
    );
    const font = new FontFace(family, bytes, { weight: '100 900' });
    document.fonts.add(font);
    void font.load().catch(() => undefined);
    return font;
  });
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const outline = document.createElementNS(svgNamespace, 'svg');
  outline.classList.add('outline');
  outline.setAttribute('viewBox', `0 0 ${imageRect.width} ${imageRect.height}`);
  if (fitImage)
    for (const element of [canvas, outline]) {
      element.style.left = `${imageRect.x}px`;
      element.style.top = `${imageRect.y}px`;
      element.style.width = `${imageRect.width}px`;
      element.style.height = `${imageRect.height}px`;
    }
  outline.setAttribute('aria-hidden', 'true');
  const shade = document.createElementNS(svgNamespace, 'path');
  shade.setAttribute('fill', '#0A0A0A55');
  shade.setAttribute('fill-rule', 'evenodd');
  const selection = document.createElementNS(svgNamespace, 'path');
  selection.setAttribute('fill', 'none');
  selection.setAttribute('stroke', '#0E5F55');
  selection.setAttribute('stroke-width', '2');
  outline.append(shade, selection);
  const backdrop = `M0 0H${imageRect.width}V${imageRect.height}H0Z`;
  function preview(path = '') {
    shade.setAttribute('d', `${backdrop}${path}`);
    selection.setAttribute('d', path);
  }
  preview();
  const instructions = document.createElement('div');
  instructions.className = 'instructions';
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.setAttribute('role', 'status');
  // size both hidden hints in the same grid cell
  // changing the hint must not move the toolbar
  hint.dataset.rectangleHint = captureHints.rectangle;
  hint.dataset.lassoHint = captureHints.lasso;
  const hintText = document.createElement('span');
  hintText.className = 'hint-text';
  hint.append(hintText);
  const modes = document.createElement('div');
  modes.className = 'modes';
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', 'Capture shape');
  const rectangle = document.createElement('button');
  rectangle.textContent = 'Rectangle';
  rectangle.type = 'button';
  const lasso = document.createElement('button');
  lasso.textContent = 'Lasso';
  lasso.type = 'button';
  modes.append(rectangle, lasso);
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.type = 'button';
  cancel.className = 'cancel';
  const retry = document.createElement('button');
  retry.textContent = 'Retry';
  retry.type = 'button';
  retry.className = 'cancel';
  retry.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(retry, cancel);
  instructions.append(modes, hint, actions);
  surface.append(canvas, outline, instructions);
  shadow.append(surface);
  const previousFocus = document.activeElement;
  const listeners = new AbortController();
  let mode: 'rectangle' | 'lasso' = 'rectangle';
  let drawing: { pointerId: number; start: Point; points: Point[] } | null = null;
  let ended = false;
  let submitting = false;
  let finishing = false;
  let pendingCompletion: CaptureEvent | undefined;
  const timer = setTimeout(
    () => stop({ type: 'capture-failed', id, message: 'Capture timed out. Select an area again.' }),
    120_000,
  );
  function cleanup() {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    listeners.abort();
    if (surface.open) surface.close();
    host.remove();
    bitmap.close();
    fonts.forEach((font) => document.fonts.delete(font));
    canvas.width = 0;
    canvas.height = 0;
    cancellation.removeEventListener('abort', abortSelection);
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
      previousFocus.focus({ preventScroll: true });
  }
  function stop(event: CaptureEvent) {
    if (ended || finishing) return;
    finishing = true;
    submitting = true;
    rectangle.disabled = true;
    lasso.disabled = true;
    pendingCompletion = event;
    retry.hidden = true;
    void finish(event).then(cleanup, (error: unknown) => {
      if (ended) return;
      finishing = false;
      retry.hidden = false;
      hintText.textContent = error instanceof Error ? error.message : 'Could not update capture.';
      retry.focus({ preventScroll: true });
    });
  }
  const cancelSelection = () => stop({ type: 'capture-cancelled', id });
  const abortSelection = () => {
    if (ended) return;
    const notify = !finishing;
    cleanup();
    if (notify) void finish({ type: 'capture-cancelled', id }).catch(() => undefined);
  };
  cancellation.addEventListener('abort', abortSelection, { once: true });
  const signal = listeners.signal;
  function setMode(next: typeof mode) {
    if (drawing && surface.hasPointerCapture(drawing.pointerId))
      surface.releasePointerCapture(drawing.pointerId);
    drawing = null;
    mode = next;
    preview();
    rectangle.setAttribute('aria-pressed', String(mode === 'rectangle'));
    lasso.setAttribute('aria-pressed', String(mode === 'lasso'));
    hintText.textContent = captureHints[mode];
  }
  setMode('rectangle');
  instructions.addEventListener('pointerdown', (event) => event.stopPropagation(), { signal });
  rectangle.addEventListener('click', () => setMode('rectangle'), { signal });
  lasso.addEventListener('click', () => setMode('lasso'), { signal });
  retry.addEventListener('click', () => {
    if (pendingCompletion) stop(pendingCompletion);
  }, { signal });
  cancel.addEventListener('click', cancelSelection, { signal });
  const point = (event: PointerEvent): Point => ({
    x: Math.max(0, Math.min(imageRect.width, event.clientX - imageRect.x)),
    y: Math.max(0, Math.min(imageRect.height, event.clientY - imageRect.y)),
  });
  const pathFor = (points: readonly Point[]) =>
    `${points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join('')}Z`;
  surface.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || !event.isPrimary || drawing || submitting) return;
      if (
        event.clientX < imageRect.x ||
        event.clientY < imageRect.y ||
        event.clientX > imageRect.x + imageRect.width ||
        event.clientY > imageRect.y + imageRect.height
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const start = point(event);
      drawing = { pointerId: event.pointerId, start, points: [start] };
      surface.setPointerCapture(event.pointerId);
      surface.focus({ preventScroll: true });
      preview();
    },
    { signal },
  );
  surface.addEventListener(
    'pointermove',
    (event) => {
      if (!drawing || drawing.pointerId !== event.pointerId || submitting) return;
      const end = point(event);
      if (mode === 'lasso') {
        const previous = drawing.points[drawing.points.length - 1] ?? drawing.start;
        if (Math.hypot(end.x - previous.x, end.y - previous.y) < 2) return;
        drawing.points.push(end);
        preview(pathFor(drawing.points));
      } else {
        const rect = selectionRect(drawing.start, end, imageRect);
        preview(`M${rect.x} ${rect.y}h${rect.width}v${rect.height}h${-rect.width}Z`);
      }
    },
    { signal },
  );
  surface.addEventListener(
    'pointerup',
    (event) => {
      if (!drawing || drawing.pointerId !== event.pointerId || submitting) return;
      event.preventDefault();
      event.stopPropagation();
      const gesture = drawing;
      drawing = null;
      if (surface.hasPointerCapture(event.pointerId))
        surface.releasePointerCapture(event.pointerId);
      gesture.points.push(point(event));
      try {
        const rect =
          mode === 'lasso'
            ? lassoRect(gesture.points, imageRect)
            : selectionRect(gesture.start, point(event), imageRect);
        const pixels = capturePixelRect(rect, imageRect, bitmap);
        const crop = document.createElement('canvas');
        crop.width = pixels.width;
        crop.height = pixels.height;
        const ctx = crop.getContext('2d');
        if (!ctx) throw new Error('Image cropping is unavailable.');
        if (mode === 'lasso') {
          ctx.save();
          ctx.translate(-pixels.x, -pixels.y);
          ctx.scale(bitmap.width / imageRect.width, bitmap.height / imageRect.height);
          ctx.clip(new Path2D(pathFor(gesture.points)), 'evenodd');
          ctx.resetTransform();
        }
        ctx.drawImage(
          bitmap,
          pixels.x,
          pixels.y,
          pixels.width,
          pixels.height,
          0,
          0,
          pixels.width,
          pixels.height,
        );
        if (mode === 'lasso') {
          ctx.restore();
          // measure the even-odd mask with fractional edge coverage
          // retraced paths can have large bounds without enclosing pixels
          const alpha = ctx.getImageData(0, 0, crop.width, crop.height).data;
          const minimum =
            16 * (bitmap.width / imageRect.width) * (bitmap.height / imageRect.height) * 255;
          let coverage = 0;
          for (let index = 3; index < alpha.length && coverage < minimum; index += 4)
            coverage += alpha[index] ?? 0;
          if (coverage < minimum)
            throw new Error('Draw a larger loop around the content, then release.');
          ctx.globalCompositeOperation = 'destination-over';
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, crop.width, crop.height);
        }
        const image = crop.toDataURL('image/png');
        if (((image.length - image.indexOf(',') - 1) * 3) / 4 > MAX_IMAGE_BYTES)
          throw new Error('Choose a smaller crop, below 12 MB.');
        submitting = true;
        stop({
          type: 'capture-finished',
          id,
          image,
          name: name ?? `Page crop - ${document.title || 'webpage'}`.slice(0, 200),
        });
      } catch (error) {
        hintText.textContent =
          error instanceof Error ? error.message : 'Could not capture this area.';
      }
    },
    { signal },
  );
  surface.addEventListener('pointercancel', cancelSelection, { signal });
  surface.addEventListener(
    'cancel',
    (event) => {
      event.preventDefault();
      cancelSelection();
    },
    { signal },
  );
  surface.addEventListener('close', cancelSelection, { signal });
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelSelection();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [rectangle, lasso, retry, cancel].filter(
          (control) => !control.hidden && !control.disabled,
        );
        const index = controls.findIndex((control) => control === shadow.activeElement);
        controls[
          index < 0
            ? event.shiftKey
              ? controls.length - 1
              : 0
            : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
        ]?.focus();
      } else if (
        (event.key === 'Enter' || event.key === ' ') &&
        [rectangle, lasso, retry, cancel].some((control) => control === shadow.activeElement)
      )
        return;
      else {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { capture: true, signal },
  );
  window.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true, passive: false, signal },
  );
  window.addEventListener('resize', cancelSelection, { signal });
  window.addEventListener('scroll', cancelSelection, { capture: true, signal });
  window.addEventListener('pagehide', cancelSelection, { signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) cancelSelection();
    },
    { signal },
  );
  window.visualViewport?.addEventListener('resize', cancelSelection, { signal });
  window.visualViewport?.addEventListener('scroll', cancelSelection, { signal });
  document.documentElement.append(host);
  try {
    // join the top layer so page dialogs cannot cover or disable capture
    surface.showModal();
    surface.focus({ preventScroll: true });
  } catch (error) {
    cleanup();
    throw error;
  }
  return abortSelection;
}
