import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = '.output/chrome-mv3';
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const packagedRoots = await readdir(root);
assert.ok(
  !packagedRoots.includes('corpus') && !packagedRoots.includes('tests'),
  'Evaluation corpus must stay outside the extension package',
);
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
assert.ok(
  !manifest.host_permissions.some((host) => /localhost|127\.0\.0\.1|<all_urls>/.test(host)),
);
assert.ok(
  !manifest.host_permissions.some((host) => host === 'http://*/*' || host === 'https://*/*'),
  'Broad capture access must not be required',
);
assert.deepEqual(
  manifest.optional_host_permissions,
  ['<all_urls>'],
  'Capture across tabs must require an optional permission grant',
);
assert.ok(
  !manifest.content_scripts?.length,
  'Capture scripts must run only on explicit invocation',
);
assert.ok(manifest.content_security_policy.extension_pages.includes("worker-src 'self'"));
for (const [size, path] of Object.entries({ ...manifest.icons, ...manifest.action.default_icon })) {
  const png = await readFile(join(root, path));
  assert.equal(png.readUInt32BE(16), Number(size), `${path} must be ${size} px wide`);
}
assert.deepEqual(Object.keys(manifest.icons), ['16', '32', '48', '128']);
const assets = await readdir(join(root, 'assets'));
const runtimeFiles = [
  'browser_ocr_runtime.mjs', 'greedy_generation.mjs', 'multimodal_ocr.mjs',
  'ocr_concurrency.mjs', 'paddleocr_vl_tasks.mjs', 'pkg/pvlc_runtime_web.js',
  'pkg/snippets/pvlc-runtime-web-2887d2e0146ca1ca/inline0.js',
];
for (const file of runtimeFiles) {
  assert.ok((await readFile(join(root, 'paddle', file))).length > 100, `${file} must be packaged locally`);
}
const wasm = await readFile(join(root, 'paddle/pkg/pvlc_runtime_web_bg.wasm'));
assert.deepEqual([...wasm.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0], 'Packaged Paddle runtime must be valid WASM');
assert.ok(WebAssembly.validate(wasm), 'The complete packaged WASM must validate');
assert.equal(createHash('sha256').update(wasm).digest('hex'), '667cf6b634f18291aa99f1540ddab613e5efbc5290bc08d0dc836ccf11c91d86', 'Packaged WASM must match the pinned upstream binary');
assert.ok(
  assets.some((name) => name.startsWith('recognition.worker-')),
  'The inference worker must be bundled',
);
for (const html of ['sidepanel.html', 'offscreen.html', 'capture-editor.html']) {
  const source = await readFile(join(root, html), 'utf8');
  assert.ok(!/<script[^>]+src=["']https?:/.test(source), 'Remote executable code is forbidden');
}
const notices = await readFile(join(root, 'licenses/NOTICE.md'), 'utf8');
assert.ok(notices.includes('PaddleOCR'));
assert.ok(!/TeleOCR|onnxruntime|@huggingface\/transformers/i.test(notices), 'Obsolete runtime dependency notices must be removed');
for (const file of [
  'PaddleOCR-NOTICE.md', 'PaddleOCR-LICENSE', 'PaddleOCR-upstream-NOTICE',
  'PaddleOCR-upstream-THIRD_PARTY_NOTICES.md', 'PaddleOCR-Rust-NOTICES.md',
]) {
  assert.ok(
    (await readFile(join(root, 'licenses', file), 'utf8')).length > 100,
    `${file} must accompany the package`,
  );
}
const worker = assets.find(
  (name) => name.startsWith('recognition.worker-') && name.endsWith('.js'),
);
assert.ok(worker);
const workerSource = await readFile(join(root, 'assets', worker), 'utf8');
const tasks = await import(new URL('../.output/chrome-mv3/paddle/paddleocr_vl_tasks.mjs', import.meta.url));
assert.equal(tasks.PADDLEOCR_VL_TASKS.formula.prompt, 'Formula Recognition:');
assert.deepEqual(tasks.recognitionOptionsForTask('formula', { maxGeneratedTokens: 2048 }).promptSuffixIds, [101306, 59352, 93514, 93963, 23, 92267, 93963, 23]);
assert.ok(workerSource.includes('paddle/browser_ocr_runtime.mjs'), 'Production worker must load the packaged Paddle runtime');
for (const retired of ['Analyze the image layout.', 'acceptance-generation', 'prompt-inference'])
  assert.ok(
    !workerSource.includes(retired),
    'Production must exclude classification and test instrumentation',
  );
assert.ok(!packagedRoots.includes('fixtures'), 'Historical benchmark fixtures must not ship');
assert.ok(!packagedRoots.includes('samples'), 'Test samples must not ship');
const csp = manifest.content_security_policy.extension_pages;
assert.ok(csp.includes("script-src 'self' 'wasm-unsafe-eval'"), 'WASM must initialize under the extension CSP');
assert.ok(!/https?:|'unsafe-eval'|'unsafe-inline'/.test(csp), 'Executable code must remain local');

async function inspect(directory) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert.ok(!/teleocr|onnxruntime|ort-wasm/i.test(path), `Retired runtime asset must not ship: ${path}`);
    if (entry.isDirectory()) {
      await inspect(path);
    } else if (/\.(?:m?js|html)$/.test(path)) {
      const source = await readFile(join(root, path), 'utf8');
      assert.ok(!/@huggingface\/transformers|onnxruntime-web|ort-runtime\//.test(source), `Retired inference runtime in ${path}`);
      assert.ok(!/(?:\bfrom\s*|\bimport\s*\(?\s*|\bimportScripts\s*\(\s*)['"]https?:/i.test(source), `Remote module import in ${path}`);
      assert.ok(!/<script[^>]+src=["']https?:/i.test(source), `Remote script in ${path}`);
      assert.ok(!/new\s+(?:Worker|SharedWorker)\s*\(\s*['"]https?:/i.test(source), `Remote worker in ${path}`);
    }
  }
}
await inspect('');
console.log('Production manifest, packaged runtime, local scripts, and notices verified');
