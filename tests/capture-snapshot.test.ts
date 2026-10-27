import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import {
  saveCaptureSnapshot,
  readCaptureSnapshot,
  deleteCaptureSnapshot,
  clearCaptureSnapshots,
} from '../src/capture-snapshot';

afterEach(clearCaptureSnapshots);

it('replaces abandoned screenshots and deletes finished capture pixels', async () => {
  const previous = { id: 'old', screenshot: 'data:image/png;base64,b2xk', name: 'Old capture' };
  const next = { id: 'new', screenshot: 'data:image/png;base64,bmV3', name: 'New capture' };
  await saveCaptureSnapshot(previous);
  expect(await readCaptureSnapshot('old')).toEqual(previous);
  await saveCaptureSnapshot(next);
  expect(await readCaptureSnapshot('old')).toBeUndefined();
  expect(await readCaptureSnapshot('new')).toEqual(next);
  await deleteCaptureSnapshot('old');
  expect(await readCaptureSnapshot('new')).toEqual(next);
  await deleteCaptureSnapshot('new');
  expect(await readCaptureSnapshot('new')).toBeUndefined();
});
