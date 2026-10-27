import { expect, it } from 'vitest';
import { assertImageHasContent } from '../src/image';

it('rejects uniform images instead of asking the model to invent text', () => {
  expect(() =>
    assertImageHasContent(new Uint8ClampedArray([255, 255, 255, 255, 255, 255]), 3),
  ).toThrow('blank');
  expect(() =>
    assertImageHasContent(new Uint8ClampedArray([0, 0, 0, 255, 255, 255]), 3),
  ).not.toThrow();
});

it('ignores invisible RGB values in fully transparent images', () => {
  expect(() =>
    assertImageHasContent(new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 0]), 4),
  ).toThrow('blank');
  expect(() =>
    assertImageHasContent(new Uint8ClampedArray([255, 255, 255, 0, 0, 0, 0, 255]), 4),
  ).not.toThrow();
});
