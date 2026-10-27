import { openDB, type DBSchema } from 'idb';
import { z } from 'zod';
import {
  stateSchema,
  resultSchema,
  scanMetadataSchema,
  inputSchema,
  type AppState,
  type RecognitionResult,
  type HistoryEntry,
} from './protocol';
import { initialState, recoverState } from './state';
import { historyEntry, combineScans, removeScans } from './history';

// save errors belong to the live workspace, not a restored record
const workspaceSchema = stateSchema
  .omit({ result: true, input: true, history: true, saveError: true })
  .extend({
    resultId: z.string().nullable(),
    input: inputSchema.omit({ image: true }).extend({ imageId: z.string() }).nullable(),
  });

// stored jobs cannot resume after a host restart
// normalize retired phases before validation to retain the saved workspace
function interruptStoredJob(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    'job' in value &&
    typeof value.job === 'object' &&
    value.job !== null &&
    'kind' in value.job &&
    value.job.kind === 'running'
  ) {
    return { ...value, job: { kind: 'interrupted' } };
  }
  return value;
}
const storedStateSchema = z.preprocess(interruptStoredJob, workspaceSchema);

function workspaceRecord(state: AppState): z.infer<typeof storedStateSchema> {
  return {
    model: state.model,
    gpu: state.gpu,
    job: state.job,
    capture: state.capture,
    resultId: state.result?.id ?? null,
    input: state.input
      ? {
          id: state.input.id,
          name: state.input.name,
          imageId:
            state.result && state.input.image === state.result.image
              ? state.result.id
              : state.input.id,
        }
      : null,
  };
}

interface ScanDatabase extends DBSchema {
  state: { key: string; value: unknown };
  scans: { key: string; value: Omit<RecognitionResult, 'image'>; indexes: { createdAt: string } };
  images: { key: string; value: string };
}

const database = () =>
  openDB<ScanDatabase>('teximagescan-prototype', 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) db.createObjectStore('state');
      if (oldVersion < 2) {
        db.createObjectStore('scans').createIndex('createdAt', 'createdAt');
        db.createObjectStore('images');
      }
    },
  });

export async function loadState(): Promise<AppState> {
  const db = await database();
  try {
    const value = await db.get('state', 'current');
    let saved = storedStateSchema.safeParse(value);
    if (!saved.success) {
      const legacy = stateSchema.safeParse(interruptStoredJob(value));
      if (legacy.success) {
        // migrate the embedded result atomically
        // retain the old record if migration fails so startup can retry
        if (legacy.data.result) await saveScan({ ...legacy.data, result: legacy.data.result });
        else await saveWorkspace(legacy.data);
        saved = storedStateSchema.safeParse(await db.get('state', 'current'));
      }
    }
    const history: HistoryEntry[] = [];
    let cursor = await db.transaction('scans').store.index('createdAt').openCursor(null, 'prev');
    while (cursor) {
      const scan = scanMetadataSchema.safeParse(cursor.value);
      if (scan.success) history.push(historyEntry(scan.data));
      cursor = await cursor.continue();
    }
    if (!saved.success) return { ...initialState(), history };
    const result = saved.data.resultId ? ((await loadScan(saved.data.resultId)) ?? null) : null;
    const image = saved.data.input ? await db.get('images', saved.data.input.imageId) : undefined;
    const input =
      saved.data.input && image
        ? { id: saved.data.input.id, name: saved.data.input.name, image }
        : null;
    return recoverState(stateSchema.parse({ ...saved.data, result, input, history }));
  } finally {
    db.close();
  }
}

async function writeState(
  state: AppState,
  scan: RecognitionResult | undefined,
  removed: readonly string[],
): Promise<void> {
  const db = await database();
  try {
    const transaction = db.transaction(['state', 'scans', 'images'], 'readwrite');
    // handle the transaction rejection while propagating the request error
    void transaction.done.catch(() => undefined);
    try {
      const next = removeScans(state, removed);
      const current = workspaceRecord(next);
      const previous = storedStateSchema.safeParse(
        await transaction.objectStore('state').get('current'),
      );
      for (const id of new Set(removed)) {
        await transaction.objectStore('scans').delete(id);
        await transaction.objectStore('images').delete(id);
      }
      if (scan) {
        const { image, ...metadata } = scan;
        await transaction.objectStore('scans').put(metadata, metadata.id);
        if ((await transaction.objectStore('images').getKey(metadata.id)) === undefined)
          await transaction.objectStore('images').put(image, metadata.id);
      }
      if (
        current.resultId &&
        (await transaction.objectStore('scans').getKey(current.resultId)) === undefined
      )
        current.resultId = null;
      await transaction.objectStore('state').put(current, 'current');
      if (
        next.input &&
        current.input &&
        (await transaction.objectStore('images').getKey(current.input.imageId)) === undefined
      )
        await transaction.objectStore('images').put(next.input.image, current.input.imageId);
      const oldInput = previous.success ? previous.data.input?.imageId : undefined;
      if (
        oldInput &&
        oldInput !== current.input?.imageId &&
        (await transaction.objectStore('scans').getKey(oldInput)) === undefined
      )
        await transaction.objectStore('images').delete(oldInput);
      await transaction.done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // a rejected transaction may already have finished
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function saveWorkspace(state: AppState): Promise<void> {
  await writeState(state, undefined, []);
}

export async function saveScan(state: AppState & { result: RecognitionResult }): Promise<void> {
  await writeState(state, state.result, []);
}

export async function loadScan(id: string): Promise<RecognitionResult | undefined> {
  const db = await database();
  try {
    const transaction = db.transaction(['scans', 'images']);
    const [metadata, image] = await Promise.all([
      transaction.objectStore('scans').get(id),
      transaction.objectStore('images').get(id),
    ]);
    return metadata && image ? resultSchema.parse({ ...metadata, image }) : undefined;
  } finally {
    db.close();
  }
}

export async function deleteScans(state: AppState, ids: readonly string[]): Promise<void> {
  await writeState(state, undefined, ids);
}

export async function exportScans(
  ids: readonly string[],
  format: 'markdown' | 'latex',
  current?: Pick<RecognitionResult, 'id' | 'createdAt' | 'edited'>,
): Promise<string> {
  const selected = [...new Set(ids)];
  const scans = current && selected.includes(current.id) ? [current] : [];
  const storedIds = selected.filter((id) => id !== current?.id);
  if (!storedIds.length) return combineScans(scans, format);
  const db = await database();
  try {
    scans.push(
      ...(await Promise.all(
        storedIds.map(async (id) => {
          const value = await db.get('scans', id);
          if (!value)
            throw new Error('A selected scan is no longer available. Select the scans again.');
          return scanMetadataSchema.parse(value);
        }),
      )),
    );
    return combineScans(scans, format);
  } finally {
    db.close();
  }
}
