export async function requireGpu(gpu: Pick<GPU, 'requestAdapter'> | undefined): Promise<string> {
  if (!gpu)
    throw new Error('WebGPU is unavailable. Use current desktop Chrome with hardware acceleration enabled.');
  // check support without creating a second device alongside Paddle's device
  // match the runtime's adapter preference and omit Chrome's ignored Windows hint
  const options: GPURequestAdapterOptions = /\bWindows\b/i.test(navigator.userAgent ?? '')
    ? {} : { powerPreference: 'high-performance' };
  const adapter = await gpu.requestAdapter(options);
  if (!adapter)
    throw new Error('Chrome could not obtain a WebGPU adapter. Check hardware acceleration and your graphics driver.');
  if (!adapter.features.has('shader-f16'))
    throw new Error('This model export requires WebGPU shader-f16 support.');
  return [adapter.info.vendor, adapter.info.architecture, adapter.info.device, adapter.info.description]
    .filter(Boolean).join(' · ') || 'WebGPU adapter';
}
