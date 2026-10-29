import type { BrowserContext } from '@playwright/test';

export function serveModelMirror(context: BrowserContext, manifest: {
  repository: string;
  revision: string;
  files: readonly { path: string; size: number }[];
}, options?: { cacheDirectory?: string }): Promise<{
  origin: string;
  readonly requests: number;
  close(): Promise<void>;
}>;
