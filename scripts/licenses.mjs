import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'public/licenses');
const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const visited = new Set();
const records = [];
// Transformers excludes native Node backends from browser builds
const excluded = new Set(['onnxruntime-node', 'sharp']);

async function packageDirectory(name, from) {
  const require = createRequire(join(from, 'package.json'));
  let directory;
  try {
    directory = dirname(require.resolve(`${name}/package.json`));
  } catch {
    directory = dirname(require.resolve(name));
  }
  while (directory !== parse(directory).root) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) return realpath(directory);
    } catch {
      /* entrypoints can live below the package directory */
    }
    directory = dirname(directory);
  }
  throw new Error(`Cannot find license metadata for ${name}`);
}

async function collect(name, from, includeDependencies = true) {
  if (excluded.has(name)) return;
  const directory = await packageDirectory(name, from);
  if (visited.has(directory)) return;
  visited.add(directory);
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^(licen[cs]e|copying|notice|third.*notice)/i.test(entry.name)) {
      files.push({ name: entry.name, text: await readFile(join(directory, entry.name), 'utf8') });
    }
  }
  // ONNX development packages omit licenses, so use the local upstream copies
  if (!files.length && name.startsWith('onnxruntime-')) {
    for (const file of ['onnxruntime-LICENSE', 'onnxruntime-ThirdPartyNotices.txt']) {
      files.push({ name: file, text: await readFile(join(output, file), 'utf8') });
    }
  }
  // MathJax font archives declare the renderer license but omit its text
  // use the complete text bundled with the renderer
  if (
    !files.length &&
    name.startsWith('@mathjax/') &&
    name.endsWith('-font') &&
    metadata.license === 'Apache-2.0'
  ) {
    const renderer = await packageDirectory('@mathjax/src', root);
    files.push({
      name: 'Apache-2.0 license (from @mathjax/src)',
      text: await readFile(join(renderer, 'LICENSE'), 'utf8'),
    });
  }
  const fallbackName = name === '@wxt-dev/browser' ? 'wxt' : name.replaceAll('/', '__');
  const fallback = join(output, `${fallbackName}-LICENSE`);
  if (!files.length) {
    try {
      files.push({ name: 'upstream LICENSE', text: await readFile(fallback, 'utf8') });
    } catch {
      /* report missing attributions after traversing dependencies */
    }
  }
  records.push({ name, version: metadata.version, license: metadata.license, files });
  if (includeDependencies) {
    for (const dependency of Object.keys(metadata.dependencies ?? {}))
      await collect(dependency, directory);
  }
}

await mkdir(output, { recursive: true });
for (const name of Object.keys(app.dependencies)) await collect(name, root);
// WXT supplies the browser API wrapper without its build dependencies
await collect('wxt', root, false);
await collect('@wxt-dev/browser', await packageDirectory('wxt', root));
const missing = records.filter((record) => !record.files.length);
if (missing.length)
  throw new Error(
    `Missing license text: ${missing.map((record) => `${record.name}@${record.version}`).join(', ')}`,
  );
records.sort((a, b) => a.name.localeCompare(b.name));
let notice = '# Third-party notices\n\n';
notice +=
  'TeleOCR and ONNX conversion: see TeleOCR-NOTICE.md. Resize helper: see teleocr-resize-LICENSE and Pillow-LICENSE.\n\n';
for (const record of records) {
  notice += `## ${record.name} ${record.version}\n\nLicense: ${record.license}\n\n`;
  for (const file of record.files) notice += `### ${file.name}\n\n${file.text}\n\n`;
}
await writeFile(join(output, 'NOTICE.md'), notice);
console.log(`Collected license texts for ${records.length} browser dependencies`);
