import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** hash local dependencies, including the WASM bridge */
export async function collectFreezeSources() {
  const files = ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml'];
  for (const root of ['src', 'public/paddle', 'scripts/math-benchmark', 'scripts/lib']) {
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
      if (entry.isFile() && !entry.parentPath.includes('__pycache__'))
        files.push(join(entry.parentPath, entry.name).replaceAll('\\', '/'));
  }
  return [...new Set(files)].sort();
}
