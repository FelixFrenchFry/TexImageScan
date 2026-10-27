import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { deleteDB, openDB } from 'idb';
import {
  loadState,
  saveScan,
  saveWorkspace,
  loadScan,
  deleteScans,
  exportScans,
} from '../src/storage';
import { initialState } from '../src/state';
import { removeScans } from '../src/history';
import { type RecognitionResult } from '../src/protocol';

const first: RecognitionResult = {
  id: 'first',
  name: 'first.png',
  image: 'data:image/png;base64,AAAA',
  original: '$x=1$',
  edited: '$x=2$',
  createdAt: '2026-10-24T10:00:00Z',
  elapsedMs: 1,
  firstTokenMs: 1,
  tokenCount: 1,
  truncated: false,
  gpu: 'test',
  modelRevision: 'test',
};
const second = {
  ...first,
  id: 'second',
  name: 'second.png',
  image: 'data:image/png;base64,BBBB',
  createdAt: '2026-10-24T11:00:00Z',
  original: '$y=3$',
  edited: '$y=3$',
};
beforeEach(() => deleteDB('teximagescan-prototype'));

it('exports the current result without opening storage when no other scans are selected', async () => {
  const unavailable = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  try {
    expect(await exportScans([first.id, first.id], 'latex', first)).toBe('x=2');
  } finally {
    unavailable.mockRestore();
  }
});

it('migrates the retained v1 result once and preserves its edits and crop', async () => {
  const db = await openDB('teximagescan-prototype', 1, {
    upgrade(db) {
      db.createObjectStore('state');
    },
  });
  await db.put('state', { ...initialState(), result: first }, 'current');
  db.close();
  const state = await loadState();
  expect(state.history.map((entry) => entry.id)).toEqual(['first']);
  expect(await loadScan('first')).toEqual(first);
  await deleteScans(removeScans(state, ['first']), ['first']);
  expect((await loadState()).history).toEqual([]);
});

it('keeps multiple scans and edits without duplicating entries, and exports selected text', async () => {
  await saveScan({ ...initialState(), result: first });
  await saveScan({ ...initialState(), result: second });
  await saveScan({ ...initialState(), result: { ...first, edited: '$x=99$' } });
  expect((await loadState()).history.map((entry) => entry.id)).toEqual(['second', 'first']);
  expect((await loadScan('first'))?.edited).toBe('$x=99$');
  expect((await loadScan('second'))?.image).toBe(second.image);
  expect(await exportScans(['second', 'first'], 'latex')).toBe('x=99\n\ny=3');
  await saveWorkspace(initialState());
  expect((await loadState()).history).toHaveLength(2);
});

it('deletes metadata and image atomically and never recreates a removed scan on restart', async () => {
  await saveScan({ ...initialState(), result: first });
  await saveScan({ ...initialState(), result: second });
  const state = await loadState();
  const next = removeScans(state, ['second']);
  await deleteScans(next, ['second']);
  await saveWorkspace(next);
  expect(await loadScan('second')).toBeUndefined();
  expect((await loadState()).history.map((entry) => entry.id)).toEqual(['first']);
  await expect(exportScans(['second'], 'markdown')).rejects.toThrow('no longer available');
  const db = await openDB('teximagescan-prototype');
  expect(await db.get('images', 'second')).toBeUndefined();
  db.close();
  const remaining = await loadState();
  await deleteScans(removeScans(remaining, ['first']), ['first']);
  expect((await loadState()).history).toEqual([]);
});

it.each([
  { ids: ['first'], remaining: ['second'] },
  { ids: ['first', 'second'], remaining: [] },
])(
  'preserves an identical independent input after deleting $ids and restarting',
  async ({ ids, remaining }) => {
    const input = { id: 'pending', name: first.name, image: first.image };
    await saveScan({ ...initialState(), result: second });
    await saveScan({ ...initialState(), result: first, input });
    const state = await loadState();
    await deleteScans(removeScans(state, ids), ids);
    const restored = await loadState();
    expect(restored.result).toBeNull();
    expect(restored.input).toEqual(input);
    expect(restored.history.map((entry) => entry.id)).toEqual(remaining);
    expect(await loadScan(first.id)).toBeUndefined();
    const db = await openDB('teximagescan-prototype');
    expect(await db.get('images', first.id)).toBeUndefined();
    expect(await db.get('images', input.id)).toBe(first.image);
    db.close();
  },
);

it('rolls back the current result when a scan transaction aborts and reports one handled failure', async () => {
  await saveScan({ ...initialState(), result: first });
  const original = IDBObjectStore.prototype.put;
  const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (this.name === 'scans') this.transaction.abort();
    return original.call(this, value, key);
  });
  try {
    await expect(saveScan({ ...initialState(), result: second })).rejects.toThrow();
  } finally {
    fail.mockRestore();
  }
  expect((await loadState()).result?.id).toBe('first');
  expect(await loadScan('second')).toBeUndefined();
});

it('updates edits without rewriting the stored crop and exports without reading images', async () => {
  await saveScan({ ...initialState(), result: first });
  const put = IDBObjectStore.prototype.put;
  const get = IDBObjectStore.prototype.get;
  const preventImageWrite = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (this.name === 'images') throw new Error('Existing crop must not be rewritten');
    return put.call(this, value, key);
  });
  const preventImageRead = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
    this: IDBObjectStore,
    key: IDBValidKey | IDBKeyRange,
  ) {
    if (this.name === 'images') throw new Error('Bulk export must not load crops');
    return get.call(this, key);
  });
  try {
    await saveScan({ ...initialState(), result: { ...first, edited: '$x=77$' } });
    expect(await exportScans(['first'], 'latex')).toBe('x=77');
  } finally {
    preventImageWrite.mockRestore();
    preventImageRead.mockRestore();
  }
  expect(await loadScan('first')).toMatchObject({ image: first.image, edited: '$x=77$' });
});

it('stores only workspace references so editing a large crop writes no embedded image bytes', async () => {
  const large = { ...first, image: `data:image/png;base64,${'A'.repeat(200_000)}` };
  await saveScan({
    ...initialState(),
    result: large,
    input: { id: 'source', image: large.image, name: large.name },
  });
  await saveScan({
    ...initialState(),
    result: { ...large, edited: '$x=55$' },
    input: { id: 'source', image: large.image, name: large.name },
  });
  const db = await openDB('teximagescan-prototype');
  const bytes = JSON.stringify(await db.get('state', 'current')).length;
  db.close();
  expect(bytes).toBeLessThan(4000);
  const restored = await loadState();
  expect(restored.result?.edited).toBe('$x=55$');
  expect(restored.input?.image).toBe(large.image);
});

it('deleting another scan does not save surviving unsaved edits or create a new history entry', async () => {
  await saveScan({ ...initialState(), result: first });
  await saveScan({ ...initialState(), result: second });
  const unsaved = { ...(await loadState()), result: { ...first, edited: '$x=88$' } };
  await deleteScans(removeScans(unsaved, ['second']), ['second']);
  expect((await loadState()).result?.edited).toBe('$x=2$');
  expect(await exportScans(['first'], 'latex')).toBe('x=2');
  const newest = { ...second, id: 'new-result', edited: '$y=99$' };
  await deleteScans(removeScans({ ...(await loadState()), result: newest }, ['first']), ['first']);
  expect((await loadState()).history).toEqual([]);
  expect(await loadScan('new-result')).toBeUndefined();
});

it('recovers an old classifying workspace without losing the current scan, pending crop, or history', async () => {
  await saveScan({
    ...initialState(),
    result: first,
    input: { id: 'pending', name: 'next.png', image: second.image },
  });
  const db = await openDB('teximagescan-prototype');
  const saved = await db.get('state', 'current');
  await db.put(
    'state',
    {
      ...saved,
      job: {
        kind: 'running',
        id: 'old-classifier',
        phase: 'classifying',
        detail: 'layout',
        fraction: null,
        text: '',
      },
    },
    'current',
  );
  db.close();
  const state = await loadState();
  expect(state.job.kind).toBe('interrupted');
  expect(state.result?.edited).toBe(first.edited);
  expect(state.result?.image).toBe(first.image);
  expect(state.input?.image).toBe(second.image);
  expect(state.history.map((entry) => entry.id)).toContain(first.id);
});

it('migrates a pre-history embedded result interrupted during the old layout pass', async () => {
  const db = await openDB('teximagescan-prototype', 1, {
    upgrade(db) {
      db.createObjectStore('state');
    },
  });
  await db.put(
    'state',
    {
      ...initialState(),
      result: {
        ...first,
        mode: 'auto',
        task: 'mixed',
        routing: { reason: 'invalid', raw: 'old-layout', elapsedMs: 1, tokenCount: 1 },
      },
      job: {
        kind: 'running',
        id: 'old-job',
        phase: 'classifying',
        detail: '',
        fraction: null,
        text: '',
      },
    },
    'current',
  );
  db.close();
  const state = await loadState();
  expect(state.job.kind).toBe('interrupted');
  expect(state.result?.edited).toBe(first.edited);
  expect(state.result?.image).toBe(first.image);
  expect(state.result).not.toHaveProperty('routing');
  expect(state.history.map((entry) => entry.id)).toEqual(['first']);
});

it('rolls back workspace changes when a write throws before issuing its request', async () => {
  await saveScan({ ...initialState(), result: first });
  const put = IDBObjectStore.prototype.put;
  const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (this.name === 'scans') throw new DOMException('Disk full', 'QuotaExceededError');
    return put.call(this, value, key);
  });
  try {
    await expect(saveScan({ ...initialState(), result: second })).rejects.toThrow('Disk full');
  } finally {
    fail.mockRestore();
  }
  expect((await loadState()).result?.id).toBe('first');
  expect(await loadScan('second')).toBeUndefined();
  const db = await openDB('teximagescan-prototype');
  expect(await db.get('scans', 'second')).toBeUndefined();
  db.close();
});

it('rolls back history and workspace together when image deletion fails', async () => {
  await saveScan({ ...initialState(), result: first });
  await saveScan({ ...initialState(), result: second });
  const state = await loadState();
  const remove = IDBObjectStore.prototype.delete;
  const fail = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
    this: IDBObjectStore,
    key: IDBValidKey | IDBKeyRange,
  ) {
    if (this.name === 'images') throw new Error('Image deletion failed');
    return remove.call(this, key);
  });
  try {
    await expect(deleteScans(removeScans(state, ['second']), ['second'])).rejects.toThrow(
      'Image deletion failed',
    );
  } finally {
    fail.mockRestore();
  }
  expect((await loadState()).result?.id).toBe('second');
  expect((await loadState()).history.map((entry) => entry.id)).toEqual(['second', 'first']);
  expect(await loadScan('second')).toEqual(second);
});
