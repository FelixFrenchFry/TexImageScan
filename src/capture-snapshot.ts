import { openDB, type DBSchema } from 'idb';
import { z } from 'zod';

export const captureSnapshotSchema = z.object({
  id: z.string(),
  screenshot: z.string().max(48_000_000).startsWith('data:image/png;base64,'),
  name: z.string().max(200),
});
export const captureSnapshotReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), snapshot: captureSnapshotSchema }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
interface CaptureDatabase extends DBSchema {
  screenshots: { key: string; value: z.infer<typeof captureSnapshotSchema> };
}
const database = () =>
  openDB<CaptureDatabase>('teximagescan-capture', 1, {
    upgrade(db) {
      db.createObjectStore('screenshots');
    },
  });

export async function saveCaptureSnapshot(
  snapshot: z.infer<typeof captureSnapshotSchema>,
): Promise<void> {
  const db = await database();
  try {
    const transaction = db.transaction('screenshots', 'readwrite');
    void transaction.done.catch(() => undefined);
    await transaction.store.clear();
    await transaction.store.put(snapshot, snapshot.id);
    await transaction.done;
  } finally {
    db.close();
  }
}

export async function readCaptureSnapshot(id: string) {
  const db = await database();
  try {
    const value = await db.get('screenshots', id);
    return value ? captureSnapshotSchema.parse(value) : undefined;
  } finally {
    db.close();
  }
}

export async function deleteCaptureSnapshot(id: string): Promise<void> {
  const db = await database();
  try {
    await db.delete('screenshots', id);
  } finally {
    db.close();
  }
}

export async function clearCaptureSnapshots(): Promise<void> {
  const db = await database();
  try {
    await db.clear('screenshots');
  } finally {
    db.close();
  }
}
