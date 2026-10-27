import assert from 'node:assert/strict';
import { recognitionInstructions } from '../src/recognition-prompts.ts';
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
assert.ok(
  assets.some((name) => name.endsWith('.wasm')),
  'WASM must be bundled for local initialization',
);
assert.ok(
  assets.some((name) => name.startsWith('recognition.worker-')),
  'The inference worker must be bundled',
);
for (const html of ['sidepanel.html', 'offscreen.html', 'capture-editor.html']) {
  const source = await readFile(join(root, html), 'utf8');
  assert.ok(!/<script[^>]+src=["']https?:/.test(source), 'Remote executable code is forbidden');
}
const notices = await readFile(join(root, 'licenses/NOTICE.md'), 'utf8');
assert.ok(notices.includes('TeleOCR'));
for (const file of ['TeleOCR-NOTICE.md', 'teleocr-resize-LICENSE', 'Pillow-LICENSE']) {
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
assert.ok(
  workerSource.includes(recognitionInstructions.auto),
  'Production Auto must use the measured concise prompt',
);
for (const retired of ['Analyze the image layout.', 'acceptance-generation', 'prompt-inference'])
  assert.ok(
    !workerSource.includes(retired),
    'Production must exclude classification and test instrumentation',
  );
assert.ok(!packagedRoots.includes('fixtures'), 'Historical benchmark fixtures must not ship');
assert.ok(!packagedRoots.includes('samples'), 'Test samples must not ship');
console.log('Production manifest, packaged runtime, local scripts, and notices verified');
