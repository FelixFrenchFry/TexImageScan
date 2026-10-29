import { describe, expect, it } from 'vitest';
import { verifyBytes } from '../src/integrity';
import {
  cachedResponse,
  cacheReady,
  modelFile,
  removeModelCaches,
  MODEL_CACHE,
} from '../src/model-cache';
import manifest from '../src/model-manifest.json';
import { vi } from 'vitest';

describe('pinned model assets', () => {
  it('accepts exact bytes and rejects a truncated download', async () => {
    const bytes = new TextEncoder().encode('abc');
    const file = {
      size: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    };
    await expect(verifyBytes(bytes, file)).resolves.toBeUndefined();
    await expect(verifyBytes(bytes.slice(0, 2), file)).rejects.toThrow('size');
  });

  it('rejects correct-length data with the wrong checksum', async () => {
    await expect(
      verifyBytes(new TextEncoder().encode('abd'), {
        size: 3,
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      }),
    ).rejects.toThrow('checksum');
  });

  it('revalidates same-length corrupted cache contents before inference reads them', async () => {
    const file = manifest.files.find((entry) => entry.path === 'README.md');
    if (!file) throw new Error('README missing from pinned model');
    const base = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/`;
    const entries = new Map(
      manifest.files.map((entry) => [
        base + entry.path,
        new Response(entry.path === file.path ? 'x'.repeat(file.size) : '', {
          headers: { 'content-length': String(entry.size) },
        }),
      ]),
    );
    entries.set(base + '__verified__', new Response(manifest.revision));
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (key: string) => entries.get(key)?.clone(),
        delete: async (key: string) => entries.delete(key),
      }),
    });
    try {
      expect((await cachedResponse(base + 'optional-metadata.json')).status).toBe(404);
      expect(await cacheReady()).toBe(true);
      await expect(
        cachedResponse(
          `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/README.md`,
        ),
      ).rejects.toThrow('checksum');
      expect(await cacheReady()).toBe(false);
      expect(entries.has(base + 'LICENSE')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('serves only the pinned repository and revision, never a matching filename from another model', () => {
    const base = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}`;
    expect(modelFile(`${base}/README.md?download=true`)).toBe('README.md');
    expect(
      modelFile(`${base.replace(manifest.revision, 'old-revision')}/README.md`),
    ).toBeUndefined();
    expect(modelFile('https://example.com/another-model/config.json')).toBeUndefined();
  });

  it('cleans obsolete model revisions and lets Remove model clear every owned revision', async () => {
    const remaining = new Set([MODEL_CACHE, 'teximagescan-model-old', 'unrelated-cache']);
    vi.stubGlobal('caches', {
      keys: async () => [...remaining],
      delete: async (name: string) => remaining.delete(name),
    });
    try {
      await removeModelCaches(MODEL_CACHE);
      expect([...remaining]).toEqual([MODEL_CACHE, 'unrelated-cache']);
      remaining.add('teximagescan-model-old');
      await removeModelCaches();
      expect([...remaining]).toEqual(['unrelated-cache']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
