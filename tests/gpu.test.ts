import { afterEach, expect, it, vi } from 'vitest';
import { requireGpu } from '../src/gpu';

afterEach(() => vi.unstubAllGlobals());
it('reports missing WebGPU and missing adapters before any model download', async () => {
  await expect(requireGpu(undefined)).rejects.toThrow('WebGPU is unavailable');
  await expect(requireGpu({ requestAdapter: async () => null })).rejects.toThrow('adapter');
});
it('requires FP16 and does not allocate an extra device', async () => {
  const requestDevice = vi.fn();
  const adapter = { features: new Set(), info: { vendor: 'nvidia', architecture: 'blackwell' }, requestDevice };
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => adapter } });
  await expect(requireGpu(navigator.gpu)).rejects.toThrow('shader-f16');
  adapter.features.add('shader-f16');
  await expect(requireGpu(navigator.gpu)).resolves.toBe('nvidia · blackwell');
  expect(requestDevice).not.toHaveBeenCalled();
});
it('checks the same adapter preference as the Paddle runtime on each platform', async () => {
  const requestAdapter = vi.fn(async () => ({ features: new Set(['shader-f16']), info: { vendor: 'test' } }));
  vi.stubGlobal('navigator', { gpu: { requestAdapter }, userAgent: 'Linux' });
  await requireGpu(navigator.gpu);
  expect(requestAdapter).toHaveBeenLastCalledWith({ powerPreference: 'high-performance' });
  vi.stubGlobal('navigator', { gpu: { requestAdapter }, userAgent: 'Windows' });
  await requireGpu(navigator.gpu);
  expect(requestAdapter).toHaveBeenLastCalledWith({});
});
