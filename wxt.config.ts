import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve('@huggingface/transformers'));
const runtimeDirectory = dirname(runtimeRequire.resolve('onnxruntime-web'));
const modelHost = process.env.WXT_MODEL_HOST;

export default defineConfig({
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  ...(modelHost ? { outDirTemplate: '{{browser}}-mv{{manifestVersion}}-benchmark' } : {}),
  vite: () => ({
    resolve: {
      alias: {
        'ort-runtime/': `${runtimeDirectory.replace(/\\/g, '/')}/`,
        '#default-font/svg/default.js': fileURLToPath(
          new URL('./src/math-svg-font.ts', import.meta.url),
        ),
      },
    },
    build: { chunkSizeWarningLimit: 2500 },
    worker: { format: 'es' },
  }),
  manifest: {
    name: 'TexImageScan',
    description: 'Recognize equations and short passages locally with TeleOCR and WebGPU.',
    minimum_chrome_version: '120',
    icons: { 16: '/icon/16.png', 32: '/icon/32.png', 48: '/icon/48.png', 128: '/icon/128.png' },
    action: {
      default_title: 'Open TexImageScan',
      default_icon: { 16: '/icon/16.png', 32: '/icon/32.png' },
    },
    permissions: ['sidePanel', 'offscreen', 'storage', 'clipboardWrite', 'activeTab', 'scripting'],
    optional_host_permissions: ['<all_urls>'],
    commands: {
      'capture-area': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Capture an equation or passage from this page',
      },
    },
    host_permissions: modelHost
      ? [`${modelHost}/*`]
      : ['https://huggingface.co/*', 'https://*.huggingface.co/*', 'https://*.hf.co/*'],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';",
    },
    cross_origin_embedder_policy: { value: 'require-corp' },
    cross_origin_opener_policy: { value: 'same-origin' },
  },
});
