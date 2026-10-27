import { expect, it, vi } from 'vitest';
import { configureGpu, requireGpu } from '../src/gpu';

it.each([
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/149.0.0.0', {}],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/149.0.0.0',
    { powerPreference: 'high-performance' },
  ],
  ['Mozilla/5.0 (X11; Linux x86_64) Chrome/149.0.0.0', { powerPreference: 'high-performance' }],
] satisfies [string, GPURequestAdapterOptions][])(
  'configures the GPU check and inference backend for %s',
  async (userAgent, expectedOptions: GPURequestAdapterOptions) => {
    // Transformers sets this preference before worker configuration
    const backend: Pick<GPURequestAdapterOptions, 'powerPreference'> = {
      powerPreference: 'high-performance',
    };
    const options = configureGpu(userAgent, backend);
    const requestAdapter = vi.fn(async () => null);

    await expect(requireGpu({ requestAdapter }, options)).rejects.toThrow(
      'could not obtain a WebGPU adapter',
    );
    expect(requestAdapter).toHaveBeenCalledExactlyOnceWith(expectedOptions);
    expect(backend.powerPreference).toBe(expectedOptions.powerPreference);
  },
);
