import { type AppState, type RecognitionResult, type HistoryEntry } from './protocol';
import { splitMath } from './preview';

type ScanText = Pick<RecognitionResult, 'id' | 'createdAt' | 'edited'>;

export function historyEntry(scan: Omit<RecognitionResult, 'image'>): HistoryEntry {
  return {
    id: scan.id,
    name: scan.name,
    createdAt: scan.createdAt,
    preview: scan.edited.slice(0, 160),
    edited: scan.edited !== scan.original,
    truncated: scan.truncated,
  };
}

export function upsertHistory(
  history: readonly HistoryEntry[],
  scan: RecognitionResult,
): HistoryEntry[] {
  return [historyEntry(scan), ...history.filter((entry) => entry.id !== scan.id)].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}

export function exportSource(source: string, format: string): string {
  if (format !== 'latex') return source;
  const parts = splitMath(source);
  if (
    parts.filter((part) => part.kind === 'math').length !== 1 ||
    parts.some((part) => part.kind === 'text' && part.source.trim())
  )
    return source;
  const text = source.trim();
  // strip wrappers from the raw source before preview normalization
  if (text.startsWith('```'))
    return text.slice(text.indexOf('\n') + 1, text.lastIndexOf('```')).trim();
  const length = text.startsWith('$$') || text.startsWith('\\[') || text.startsWith('\\(') ? 2 : 1;
  return text.slice(length, -length);
}

export function combineScans(scans: readonly ScanText[], format: 'markdown' | 'latex'): string {
  return [...scans]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((scan) => exportSource(scan.edited, format))
    .join('\n\n');
}

export function removeScans(state: AppState, ids: readonly string[]): AppState {
  const removed = new Set(ids);
  const removingCurrent = state.result !== null && removed.has(state.result.id);
  return {
    ...state,
    history: state.history.filter((entry) => !removed.has(entry.id)),
    result: removingCurrent ? null : state.result,
    input: removingCurrent && state.input?.id === state.result?.id ? null : state.input,
  };
}
