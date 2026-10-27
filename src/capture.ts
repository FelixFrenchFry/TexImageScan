import { z } from 'zod';

const coordinate = z.number().finite();
export const captureReplySchema = z.object({ ok: z.boolean(), message: z.string().optional() });
export const viewportSchema = z.object({
  width: coordinate.positive(),
  height: coordinate.positive(),
  scrollX: coordinate,
  scrollY: coordinate,
  scale: coordinate.positive(),
});
export type CaptureViewport = z.infer<typeof viewportSchema>;
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = Point & Size;
export const CAPTURE_ACCESS_MESSAGE =
  'Click the TexImageScan toolbar icon on this tab to enable capture, then try again.';

export function captureErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Could not start capture.';
  if (/file URLs|file:\/\//i.test(message))
    return 'To capture local files, enable "Allow access to file URLs" for TexImageScan in Chrome, then try again.';
  if (/activeTab|<all_urls>|Missing host permission|Cannot access contents/i.test(message))
    return CAPTURE_ACCESS_MESSAGE;
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(message))
    return 'Wait a moment before capturing again.';
  if (
    /captur(?:e|ing).*disabled|screenshots?.*(?:disabled|blocked)|not allowed to capture/i.test(
      message,
    )
  )
    return 'Chrome blocked screenshots on this tab. Upload a screenshot instead.';
  return message;
}

export function fitImageRect(image: Size, viewport: Size): Rect {
  const scale = Math.min(viewport.width / image.width, viewport.height / image.height);
  const width = image.width * scale,
    height = image.height * scale;
  return { x: (viewport.width - width) / 2, y: (viewport.height - height) / 2, width, height };
}

export function selectionRect(start: Point, end: Point, viewport: Size): Rect {
  const x = Math.max(0, Math.min(viewport.width, Math.min(start.x, end.x)));
  const y = Math.max(0, Math.min(viewport.height, Math.min(start.y, end.y)));
  return {
    x,
    y,
    width: Math.max(0, Math.min(viewport.width, Math.max(start.x, end.x)) - x),
    height: Math.max(0, Math.min(viewport.height, Math.max(start.y, end.y)) - y),
  };
}

export function capturePixelRect(rect: Rect, viewport: Size, screenshot: Size): Rect {
  if (rect.width < 4 || rect.height < 4)
    throw new Error('Select a larger area, at least 4 pixels in each direction.');
  const scaleX = screenshot.width / viewport.width;
  const scaleY = screenshot.height / viewport.height;
  const x = Math.max(0, Math.floor(rect.x * scaleX));
  const y = Math.max(0, Math.floor(rect.y * scaleY));
  const right = Math.min(screenshot.width, Math.ceil((rect.x + rect.width) * scaleX));
  const bottom = Math.min(screenshot.height, Math.ceil((rect.y + rect.height) * scaleY));
  const width = right - x,
    height = bottom - y;
  if (width <= 0 || height <= 0) throw new Error('The selection is outside the captured viewport.');
  if (width * height > 8_000_000) throw new Error('Select an area with at most 8 million pixels.');
  return { x, y, width, height };
}

export function lassoRect(points: readonly Point[], viewport: Size): Rect {
  const first = points[0];
  if (!first || points.length < 3) throw new Error('Draw a loop around the content, then release.');
  let left = first.x,
    right = first.x,
    top = first.y,
    bottom = first.y;
  for (const point of points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  return selectionRect({ x: left, y: top }, { x: right, y: bottom }, viewport);
}

export const capturePageMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('capture-viewport') }),
  z.object({
    type: z.literal('capture-show'),
    id: z.string(),
    screenshot: z.string().max(48_000_000).startsWith('data:image/png;base64,'),
    viewport: viewportSchema,
  }),
  z.object({ type: z.literal('capture-dismiss'), id: z.string() }),
]);
