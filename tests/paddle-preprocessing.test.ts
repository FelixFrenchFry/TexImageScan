import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';

const module: unknown = await import(pathToFileURL(resolve('public/paddle/multimodal_ocr.mjs')).href);
if (typeof module !== 'object' || module === null || !('preprocessImage' in module) || typeof module.preprocessImage !== 'function')
  throw new Error('Paddle preprocessing export missing');
const preprocess = module.preprocessImage;
const image = z.object({ gridThw: z.tuple([z.number(), z.number(), z.number()]), pixelValues: z.instanceof(Float32Array) });

it('preserves the pinned default pixel packing when no override is supplied', () => {
  const pixels = Uint8Array.from({ length: 70 * 42 * 3 }, (_, index) => (index * 37 + Math.floor(index / 70) * 11) % 256);
  const output = image.parse(preprocess(pixels, 42, 70));
  expect(output.gridThw).toEqual([1, 20, 32]);
  expect(createHash('sha256').update(new Uint8Array(output.pixelValues.buffer)).digest('hex'))
    .toBe('0a7217a1c97e1a71b31a9a8bb3f8ae78e4c5c5329aec805daca58789705943ca');
});

it('can increase detail for small crops without changing the model or input bytes', () => {
  const pixels = new Uint8Array(64 * 64 * 3).fill(128);
  const standard = image.parse(preprocess(pixels, 64, 64));
  const detailed = image.parse(preprocess(pixels, 64, 64, 3, { minPixels: 225_792, maxPixels: 1_003_520 }));
  expect(detailed.gridThw[1] * detailed.gridThw[2]).toBeGreaterThan(standard.gridThw[1] * standard.gridThw[2]);
});

it('can retain more source pixels on large crops within an explicit bounded budget', () => {
  const pixels = new Uint8Array(1600 * 900 * 3).fill(128);
  const standard = image.parse(preprocess(pixels, 900, 1600));
  const detailed = image.parse(preprocess(pixels, 900, 1600, 3, { minPixels: 112_896, maxPixels: 2_007_040 }));
  expect(detailed.gridThw[1] * detailed.gridThw[2]).toBeGreaterThan(standard.gridThw[1] * standard.gridThw[2]);
  expect(detailed.gridThw[1] * detailed.gridThw[2] * 14 * 14).toBeLessThanOrEqual(2_007_040);
});
