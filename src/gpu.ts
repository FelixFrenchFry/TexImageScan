export function configureGpu(
  userAgent: string,
  backend: Pick<GPURequestAdapterOptions, 'powerPreference'> | undefined,
): GPURequestAdapterOptions {
  // Chrome ignores the power hint on Windows and warns when it is supplied
  const options: GPURequestAdapterOptions = /\bWindows\b/i.test(userAgent)
    ? {}
    : { powerPreference: 'high-performance' };
  if (backend) backend.powerPreference = options.powerPreference;
  return options;
}

export async function requireGpu(
  gpu: Pick<GPU, 'requestAdapter'> | undefined,
  options: GPURequestAdapterOptions,
) {
  if (!gpu)
    throw new Error(
      'WebGPU is unavailable. Use current desktop Chrome with hardware acceleration enabled.',
    );
  const adapter = await gpu.requestAdapter(options);
  if (!adapter)
    throw new Error(
      'Chrome could not obtain a WebGPU adapter. Check hardware acceleration and your graphics driver.',
    );
  if (!adapter.features.has('shader-f16'))
    throw new Error('This model export requires WebGPU shader-f16 support.');
  // ONNX creates another adapter unless given an external device
  // enable compute features and full limits to retain f16 support
  // and enough buffer capacity for model weights
  const requiredLimits: Record<string, number> = {};
  for (const name in adapter.limits) {
    const value: unknown = Reflect.get(adapter.limits, name);
    if (typeof value === 'number') requiredLimits[name] = value;
  }
  const requiredFeatures = (
    ['shader-f16', 'subgroups', 'timestamp-query'] satisfies GPUFeatureName[]
  ).filter((feature) => adapter.features.has(feature));
  const device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
  const description =
    [adapter.info.vendor, adapter.info.architecture, adapter.info.device, adapter.info.description]
      .filter(Boolean)
      .join(' · ') || 'WebGPU adapter';
  return {
    adapter,
    device,
    description,
    sessionOptions: { executionProviders: [{ name: 'webgpu' satisfies 'webgpu', device }] },
  };
}
