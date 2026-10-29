#!/usr/bin/env node
// CPU-only Chrome image decoding and preprocessing
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { z } from 'zod';
import { browserExecutable } from '../browser.mjs';
import { readAccuracyManifest, sha256 } from '../math-benchmark/dataset.ts';

const multimodal: unknown = await import(pathToFileURL(resolve('public/paddle/multimodal_ocr.mjs')).href);
assert.ok(typeof multimodal === 'object' && multimodal && 'preprocessImage' in multimodal &&
  typeof multimodal.preprocessImage === 'function', 'Runtime preprocessing export unavailable');
const preprocessImage = multimodal.preprocessImage;
const preprocessingSchema = z.object({ pixelValues: z.instanceof(Float32Array),
  gridThw: z.tuple([z.number().int().positive(), z.number().int().positive(), z.number().int().positive()]) });

const manifestPath = process.argv[2];
assert.ok(manifestPath, 'Usage: node scripts/paddle-diagnostics/decode-rgb.ts MANIFEST [OUTPUT_DIRECTORY]');
const output = resolve(process.argv[3] ?? 'artifacts/paddle-diagnostics/source-rgb');
const { manifest, manifestSha256 } = await readAccuracyManifest(manifestPath);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: ['--disable-gpu'] });
try {
  const page = await browser.newPage();
  const cases: { id: string; sourceFile: string; sourceSha256: string; width: number; height: number;
    file: string; rgbSha256: string; pixelFile: string; pixelSha256: string; grid: number[] }[] = [];
  for (const sample of manifest.cases) {
    const png = await readFile(sample.image.file);
    if (sha256(png) !== sample.image.sha256) throw new Error(`Source SHA mismatch: ${sample.id}`);
    const decoded = await page.evaluate(async (encoded) => {
      const blob = await (await fetch(`data:image/png;base64,${encoded}`)).blob();
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas 2D context unavailable');
      context.fillStyle = 'white'; context.fillRect(0, 0, bitmap.width, bitmap.height);
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const rgb = new Uint8Array(bitmap.width * bitmap.height * 3);
      for (let from = 0, to = 0; from < rgba.length; from += 4) {
        rgb.set(rgba.subarray(from, from + 3), to); to += 3;
      }
      const chunks: string[] = [];
      for (let index = 0; index < rgb.length; index += 32768) chunks.push(String.fromCharCode(...rgb.subarray(index, index + 32768)));
      const result = { width: bitmap.width, height: bitmap.height, base64: btoa(chunks.join('')) };
      bitmap.close(); return result;
    }, png.toString('base64'));
    const rgb = Buffer.from(decoded.base64, 'base64');
    const file = `${sample.id}.rgb.bin`;
    await writeFile(join(output, file), rgb);
    const preprocessed = preprocessingSchema.parse(preprocessImage(rgb, decoded.height, decoded.width));
    const pixels = Buffer.from(preprocessed.pixelValues.buffer);
    const pixelFile = `${sample.id}.node-preprocessed.f32.bin`;
    await writeFile(join(output, pixelFile), pixels);
    cases.push({ id: sample.id, sourceFile: sample.image.file, sourceSha256: sha256(png),
      width: decoded.width, height: decoded.height, file, rgbSha256: sha256(rgb),
      pixelFile, pixelSha256: sha256(pixels), grid: preprocessed.gridThw });
  }
  const report = { version: 1, cpuOnly: true, chromeVersion: browser.version(),
    manifestSha256, runtimeSha256: sha256(await readFile('public/paddle/multimodal_ocr.mjs')),
    cases };
  await writeFile(join(output, 'decoded.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ cases: cases.length, chromeVersion: browser.version(), output }));
} finally { await browser.close(); }
