import manifest from './model-manifest.json';
import { verifyBytes } from './integrity';

export const MODEL_CACHE = `teximagescan-model-${manifest.revision}`;
const origin = 'https://huggingface.co';
const base = `${origin}/${manifest.repository}/resolve/${manifest.revision}/`;
const completeKey = `${base}__verified__`;

export async function removeModelCaches(keep?: string): Promise<void> {
  for (const name of await caches.keys()) {
    if (name.startsWith('teximagescan-model-') && name !== keep) await caches.delete(name);
  }
}

export function modelFile(request: string): string | undefined {
  const url = request.split('?')[0];
  return manifest.files.find((file) => url === base + file.path)?.path;
}

export async function cacheReady(): Promise<boolean> {
  const cache = await caches.open(MODEL_CACHE);
  if (!(await cache.match(completeKey))) return false;
  for (const file of manifest.files) {
    const response = await cache.match(base + file.path);
    if (!response || response.headers.get('content-length') !== String(file.size)) return false;
  }
  return true;
}

export async function cachedResponse(request: string): Promise<Response> {
  const file = modelFile(request);
  if (!file) return new Response('File not in the pinned local model', { status: 404 });
  const cache = await caches.open(MODEL_CACHE);
  const response = await cache.match(base + file);
  if (!response) return new Response('File not in the pinned local model', { status: 404 });
  const entry = manifest.files.find((item) => item.path === file);
  if (!entry) return new Response('File not in the pinned local model', { status: 404 });
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    await verifyBytes(bytes, entry);
    return new Response(bytes, { headers: response.headers });
  } catch (error) {
    // retain verified files so an explicit download can resume
    await cache.delete(completeKey);
    throw error;
  }
}

export async function downloadModel(
  onProgress: (detail: string, fraction: number) => void,
): Promise<void> {
  const cache = await caches.open(MODEL_CACHE);
  await cache.delete(completeKey);
  let completed = 0;
  for (const file of manifest.files) {
    const key = base + file.path;
    const stored = await cache.match(key);
    if (stored) {
      try {
        await verifyBytes(new Uint8Array(await stored.arrayBuffer()), file);
        completed += file.size;
        onProgress(`Verified ${file.path}`, completed / manifest.totalBytes);
        continue;
      } catch {
        await cache.delete(key);
      }
    }
    const cancellation = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          cancellation.abort(
            new DOMException(
              `Model download stalled: ${file.path}. Check your connection and retry.`,
              'TimeoutError',
            ),
          ),
        15 * 60_000,
      );
    };
    let loaded = 0;
    try {
      resetTimer();
      const response = await fetch(key, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: cancellation.signal,
      });
      resetTimer();
      if (!response.ok || !response.body)
        throw new Error(`Model download failed (${response.status}): ${file.path}`);
      const progress = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          if (loaded > file.size) throw new Error(`Unexpected model file size: ${file.path}`);
          if (chunk.byteLength > 0) resetTimer();
          onProgress(file.path, (completed + loaded) / manifest.totalBytes);
          controller.enqueue(chunk);
        },
        flush() {
          clearTimeout(timer);
        },
      });
      // stream to cache because Chrome rejects responses backed by huge ArrayBuffers
      // publish the completion marker only after verification
      await cache.put(
        key,
        new Response(response.body.pipeThrough(progress), {
          headers: {
            'content-length': String(file.size),
            'content-type': 'application/octet-stream',
          },
        }),
      );
      const saved = await cache.match(key);
      if (!saved) throw new Error(`Could not cache model file: ${file.path}`);
      await verifyBytes(new Uint8Array(await saved.arrayBuffer()), file);
    } catch (error) {
      await cache.delete(key);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    completed += loaded;
  }
  await cache.put(completeKey, new Response(manifest.revision));
  await removeModelCaches(MODEL_CACHE);
}
