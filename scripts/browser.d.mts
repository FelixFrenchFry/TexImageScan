import type { BrowserContext, Page } from '@playwright/test';

export function browserExecutable(): string;
export function waitForPanel(page: Page): Promise<void>;
export function openExtension(options?: {
  directory?: string;
  profile?: string;
  gpu?: boolean;
  deviceScaleFactor?: number;
  headless?: boolean;
  viewport?: { width: number; height: number };
}): Promise<{
  context: BrowserContext;
  page: Page;
  id: string;
  close(): Promise<void>;
}>;
