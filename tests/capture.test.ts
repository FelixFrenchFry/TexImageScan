import { expect, it } from 'vitest';
import {
  capturePixelRect,
  selectionRect,
  lassoRect,
  fitImageRect,
  captureErrorMessage,
} from '../src/capture';

it('distinguishes missing tab access, local file access and browser screenshot restrictions', () => {
  expect(
    captureErrorMessage(
      new Error("Either the '<all_urls>' or 'activeTab' permission is required."),
    ),
  ).toContain('toolbar icon');
  expect(captureErrorMessage(new Error('Not allowed to access file URLs'))).toContain(
    'Allow access to file URLs',
  );
  expect(captureErrorMessage(new Error('Capturing of the current tab is disabled'))).toContain(
    'Upload a screenshot',
  );
  expect(
    captureErrorMessage(new Error('This request exceeds MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')),
  ).toContain('Wait a moment');
  expect(captureErrorMessage(new Error('The active tab changed. Capture the area again.'))).toBe(
    'The active tab changed. Capture the area again.',
  );
});

it('fits screenshot selection without distortion and maps back to original pixels', () => {
  const image = { width: 1600, height: 900 };
  const fitted = fitImageRect(image, { width: 800, height: 600 });
  expect(fitted).toEqual({ x: 0, y: 75, width: 800, height: 450 });
  expect(capturePixelRect({ x: 100, y: 50, width: 200, height: 100 }, fitted, image)).toEqual({
    x: 200,
    y: 100,
    width: 400,
    height: 200,
  });
  expect(fitImageRect({ width: 600, height: 1200 }, { width: 800, height: 600 })).toEqual({
    x: 250,
    y: 0,
    width: 300,
    height: 600,
  });
});

it('normalizes reverse drags and clamps the selection to the viewport', () => {
  expect(selectionRect({ x: 130, y: 90 }, { x: -5, y: 20 }, { width: 120, height: 80 })).toEqual({
    x: 0,
    y: 20,
    width: 120,
    height: 60,
  });
});

it('maps CSS coordinates to actual screenshot pixels without assuming devicePixelRatio', () => {
  expect(
    capturePixelRect(
      { x: 10.25, y: 20.25, width: 100.5, height: 40.5 },
      { width: 800, height: 600 },
      { width: 1200, height: 900 },
    ),
  ).toEqual({ x: 15, y: 30, width: 152, height: 62 });
});

it('clamps the bottom/right boundary and rejects tiny or excessive crops', () => {
  expect(
    capturePixelRect(
      { x: 790, y: 590, width: 50, height: 50 },
      { width: 800, height: 600 },
      { width: 1600, height: 1200 },
    ),
  ).toEqual({ x: 1580, y: 1180, width: 20, height: 20 });
  expect(() =>
    capturePixelRect(
      { x: 0, y: 0, width: 1, height: 1 },
      { width: 800, height: 600 },
      { width: 800, height: 600 },
    ),
  ).toThrow('larger');
  expect(() =>
    capturePixelRect(
      { x: 0, y: 0, width: 2000, height: 2000 },
      { width: 2000, height: 2000 },
      { width: 4000, height: 4000 },
    ),
  ).toThrow('8 million');
});

it('bounds a freehand outline regardless of drawing direction and clamps it to the viewport', () => {
  const points = [
    { x: 20, y: 10 },
    { x: 110, y: 40 },
    { x: 30, y: 90 },
    { x: -5, y: 30 },
  ];
  expect(lassoRect(points, { width: 100, height: 80 })).toEqual({
    x: 0,
    y: 10,
    width: 100,
    height: 70,
  });
  expect(lassoRect([...points].reverse(), { width: 100, height: 80 })).toEqual(
    lassoRect(points, { width: 100, height: 80 }),
  );
});

it('requires enough points to bound a lasso and accepts self-intersecting outlines', () => {
  const viewport = { width: 100, height: 100 };
  for (const points of [
    [],
    [{ x: 10, y: 10 }],
    [
      { x: 10, y: 10 },
      { x: 50, y: 50 },
    ],
  ]) {
    expect(() => lassoRect(points, viewport)).toThrow('loop');
  }
  expect(
    lassoRect(
      [
        { x: 10, y: 10 },
        { x: 90, y: 90 },
        { x: 10, y: 90 },
        { x: 90, y: 10 },
      ],
      viewport,
    ),
  ).toEqual({ x: 10, y: 10, width: 80, height: 80 });
});
