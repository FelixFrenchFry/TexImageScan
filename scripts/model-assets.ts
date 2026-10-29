import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import manifest from '../src/model-manifest.json' with { type: 'json' };

const command = process.argv[2];
if (command !== 'download' && command !== 'verify') {
  throw new Error('Usage: node scripts/model-assets.ts <download|verify>');
}

const root = resolve(import.meta.dirname, '..');
const cacheRoot = join(root, '.model-cache', manifest.repository, 'resolve', manifest.revision);

async function hashFile(path: string): Promise<{ hash: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { hash: hash.digest('hex'), size };
}

for (const file of manifest.files) {
  const destination = join(cacheRoot, file.path);
  let existing: Awaited<ReturnType<typeof hashFile>> | undefined;
  try {
    existing = await hashFile(destination);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (existing?.hash === file.sha256 && existing.size === file.size) continue;
  if (command === 'verify') throw new Error(`Missing or invalid: ${file.path}`);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  try {
    const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${file.path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!response.ok) throw new Error(`${response.status} from ${url}`);
    if (!response.body) throw new Error(`No response body: ${file.path}`);
    const hash = createHash('sha256');
    let size = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    const body = response.body;
    async function* chunks() {
      const reader = body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          yield chunk.value;
        }
      } finally {
        reader.releaseLock();
      }
    }
    await pipeline(Readable.from(chunks()), verify, createWriteStream(temporary));
    if (size !== file.size || hash.digest('hex') !== file.sha256) {
      throw new Error(`Integrity check failed: ${file.path}`);
    }
    await rename(temporary, destination);
    console.log(`Verified ${file.path} (${size} bytes)`);
  } finally {
    await rm(temporary, { force: true });
  }
}
console.log(`All ${manifest.files.length} pinned ${manifest.displayName} model files verified`);
