import { env } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';
import runtimeMjs from 'ort-runtime/ort-wasm-simd-threaded.asyncify.mjs?url';
import runtimeWasm from 'ort-runtime/ort-wasm-simd-threaded.asyncify.wasm?url';
import { configureGpu, requireGpu } from '../../src/gpu.ts';

// use a tiny ONNX Add graph without weights or GPU emulation
const integer = (field, value) => [field << 3, value];
const message = (field, bytes) => [(field << 3) | 2, bytes.length, ...bytes];
const string = (field, value) => message(field, [...new TextEncoder().encode(value)]);
const tensor = (name) => [
  ...string(1, name),
  ...message(2, message(1, [...integer(1, 1), ...message(2, message(1, integer(1, 2)))])),
];
const graph = [
  ...message(1, [...string(1, 'x'), ...string(1, 'y'), ...string(2, 'z'), ...string(4, 'Add')]),
  ...string(2, 'gpu-regression'),
  ...message(11, tensor('x')),
  ...message(11, tensor('y')),
  ...message(12, tensor('z')),
];
// fixture lengths fit in one protobuf varint byte
const model = new Uint8Array([
  ...integer(1, 10),
  ...message(7, graph),
  ...message(8, integer(2, 13)),
]);

window.runGpuRegression = async () => {
  const requests = [];
  const original = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = (options) => {
    requests.push(options ?? {});
    return original(options);
  };
  const backend = env.backends.onnx.webgpu;
  const context = await requireGpu(navigator.gpu, configureGpu(navigator.userAgent, backend));
  backend.adapter = context.adapter;
  ort.env.wasm.wasmPaths = {
    mjs: new URL(runtimeMjs, location.href).href,
    wasm: new URL(runtimeWasm, location.href).href,
  };
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const results = [];
  for (let index = 0; index < 3; index++) {
    const session = await ort.InferenceSession.create(model, context.sessionOptions);
    const output = await session.run({
      x: new ort.Tensor('float32', new Float32Array([1, 2]), [2]),
      y: new ort.Tensor('float32', new Float32Array([3, 4]), [2]),
    });
    results.push([...output.z.data]);
    await session.release();
  }
  return {
    requests,
    results,
    description: context.description,
    features: [...context.device.features],
  };
};
