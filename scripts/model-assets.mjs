import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(import.meta.dirname, '..');
const manifestPath = join(root, 'src/model-manifest.json');
const repository = 'stefanj0/TeleOCR-ONNX';
const revision = '3bbc0e0f541b2ddd6f2c238f3ee0493c982cb0ac';
const sourceModel = 'XingChen-AGI/TeleOCR';
const sourceRevision = '70a19ec6a3b036311af19ae5e762e650f41a5980';

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response;
}

if (process.argv[2] === 'pin') {
  const info = await (
    await request(`https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`)
  ).json();
  if (info.sha !== revision)
    throw new Error('Export revision changed; inspect before updating the pin');
  const files = [];
  // download model data and keep executable resize code bundled locally
  const selected = info.siblings.filter(
    ({ rfilename }) =>
      (!rfilename.includes('/') && !rfilename.startsWith('.')) ||
      /^onnx\/(decoder_model_merged|embed_tokens|vision_encoder)_q4f16\.onnx(?:_data)?$/.test(
        rfilename,
      ),
  );
  for (const entry of selected) {
    let sha256 = entry.lfs?.sha256;
    if (!sha256) {
      const bytes = await (
        await request(`https://huggingface.co/${repository}/resolve/${revision}/${entry.rfilename}`)
      ).arrayBuffer();
      sha256 = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    }
    files.push({ path: entry.rfilename, size: entry.size, sha256 });
  }
  const manifest = {
    displayName: 'TeleOCR',
    sourceModel,
    sourceRevision,
    repository,
    revision,
    license: 'Apache-2.0',
    precision: { decoder_model_merged: 'q4f16', embed_tokens: 'q4f16', vision_encoder: 'q4f16' },
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files,
    provenance:
      'Community ONNX conversion of TeleOCR. q4f16 uses 4-bit decoder and embeddings, FP16 KV cache, and FP16 vision weights. Source revision records the inspected original checkpoint; native parity claims are from the converter and need local evaluation.',
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Pinned ${files.length} files, ${manifest.totalBytes} bytes`);
} else {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const cacheRoot = join(root, '.model-cache', manifest.repository, 'resolve', manifest.revision);
  const hashFile = async (path) => {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
      size += chunk.length;
    }
    return { hash: hash.digest('hex'), size };
  };
  for (const file of manifest.files) {
    const destination = join(cacheRoot, file.path);
    let existing;
    try {
      existing = await hashFile(destination);
    } catch {
      /* missing assets are downloaded below */
    }
    if (existing?.hash === file.sha256 && existing.size === file.size) continue;
    if (process.argv[2] !== 'download') throw new Error(`Missing or invalid: ${file.path}`);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.part`;
    const response = await request(
      `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${file.path}`,
    );
    if (!response.body) throw new Error(`No response body: ${file.path}`);
    const hash = createHash('sha256');
    let size = 0;
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(temporary));
      if (size !== file.size || hash.digest('hex') !== file.sha256)
        throw new Error(`Integrity check failed: ${file.path}`);
      await rename(temporary, destination);
      console.log(`Verified ${file.path} (${size} bytes)`);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  console.log(`All ${manifest.files.length} pinned model files verified`);
}
