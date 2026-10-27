import { expect, it } from 'vitest';
import { createModelLoadProgress } from '../src/model-progress';

it('measures verified model bytes across parallel files without double counting retries', () => {
  const verified = createModelLoadProgress([
    { path: 'small.onnx', size: 100 },
    { path: 'large.onnx_data', size: 300 },
  ]);
  expect(verified('unrelated.json')).toBeUndefined();
  expect(verified('large.onnx_data')).toBe(0.75);
  expect(verified('large.onnx_data')).toBeUndefined();
  expect(verified('small.onnx')).toBe(1);
});

it('starts a fresh measurement when the model is reloaded', () => {
  const files = [{ path: 'weights', size: 100 }];
  expect(createModelLoadProgress(files)('weights')).toBe(1);
  expect(createModelLoadProgress(files)('other')).toBeUndefined();
});
