import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { prepareTeleocrPixels } from '../src/teleocr-image';

// Pillow goldens use white alpha compositing and RGB bicubic resizing
// cover half-even rounding, scaling and alpha flattening
it.each([
  [70, 42, 56, 56, '3ed3d323dda40bb08ba54cd5c2102499cf035c53bbcd1a68454a577c27893402'],
  [230, 90, 224, 84, 'dff871db55b1cd5c4a8f6b2290b7777182e25c9c364a799ac4039d1df0e0b0dc'],
] as const)(
  'matches Pillow for a %i × %i RGBA crop',
  (width, height, targetWidth, targetHeight, sha256) => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        rgba.set(
          [
            (x * 17 + y * 3) % 256,
            (x * 5 + y * 19) % 256,
            (x * 7 + y * 11) % 256,
            [0, 128, 255][(x + y) % 3] ?? 0,
          ],
          (y * width + x) * 4,
        );
      }
    const image = prepareTeleocrPixels(rgba, width, height);
    expect([image.width, image.height]).toEqual([targetWidth, targetHeight]);
    expect(createHash('sha256').update(image.data).digest('hex')).toBe(sha256);
  },
);

it('preserves a very wide, 14-pixel-high crop by padding its short side', () => {
  const data = new Uint8ClampedArray(2000 * 14 * 4).fill(255);
  data.set([0, 0, 0, 255], 0);
  const image = prepareTeleocrPixels(data, 2000, 14);
  expect([image.width, image.height]).toEqual([1988, 28]);
});

it('rejects an image that becomes blank when white and transparent pixels are composited', () => {
  expect(() =>
    prepareTeleocrPixels(new Uint8ClampedArray([255, 255, 255, 0, 255, 255, 255, 255]), 2, 1),
  ).toThrow('blank');
});

it('bounds the vision input for large crops while preserving their content', () => {
  const data = new Uint8ClampedArray(1008 * 1008 * 4).fill(255);
  data.set([0, 0, 0, 255], (504 * 1008 + 504) * 4);
  const image = prepareTeleocrPixels(data, 1008, 1008);
  expect([image.width, image.height]).toEqual([980, 980]);
  expect(image.data.some((value) => value < 255)).toBe(true);
});
