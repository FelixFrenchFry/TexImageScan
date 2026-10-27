import { expect, it } from 'vitest';
import { initialState } from '../src/state';
import { type AppState, type RecognitionResult } from '../src/protocol';
import { historyEntry } from '../src/history';
import { inactiveWorkspace, visibleWorkspace } from '../src/panel-workspace';

const scan: RecognitionResult = {
  id: 'saved',
  name: 'equation.png',
  image: 'data:image/png;base64,AAAA',
  original: '$x=1$',
  edited: '$x=2$',
  createdAt: '2026-10-26T10:00:00Z',
  elapsedMs: 1200,
  firstTokenMs: 100,
  tokenCount: 12,
  truncated: false,
  gpu: 'test',
  modelRevision: 'test',
};
const saved: AppState = {
  ...initialState(),
  result: scan,
  input: { id: 'crop', name: scan.name, image: scan.image },
  history: [historyEntry(scan)],
};

it('starts with no active scan without changing the stored crop, edits, or history', () => {
  expect(visibleWorkspace(saved, inactiveWorkspace(saved))).toEqual({ result: null, input: null });
  expect(saved.result?.edited).toBe('$x=2$');
  expect(saved.history).toEqual([historyEntry(scan)]);
  expect(saved.input?.image).toBe(scan.image);
});

it('keeps an unsaved result visible when a panel opens or another panel fails to save', () => {
  const unsaved = { ...saved, saveError: 'Storage unavailable' };
  expect(visibleWorkspace(unsaved, inactiveWorkspace(unsaved)).result).toEqual(scan);
  expect(visibleWorkspace(unsaved, inactiveWorkspace(saved)).result).toEqual(scan);
});

it('shows an ongoing recognition input without selecting the previous completed scan', () => {
  const running: AppState = {
    ...saved,
    job: { kind: 'running', id: 'new', phase: 'recognizing', detail: '', fraction: null, text: '' },
  };
  expect(visibleWorkspace(running, inactiveWorkspace(running))).toEqual({
    result: null,
    input: saved.input,
  });
});

it('does not reactivate an old crop while only downloading the model', () => {
  const downloading: AppState = {
    ...saved,
    job: {
      kind: 'running',
      id: 'model',
      phase: 'downloading',
      detail: '',
      fraction: null,
      text: '',
    },
  };
  expect(visibleWorkspace(downloading, inactiveWorkspace(downloading))).toEqual({
    result: null,
    input: null,
  });
});

it('shows a newly captured image without reviving the dismissed scan as a previous result', () => {
  const input = { id: 'new-crop', name: 'next.png', image: 'data:image/png;base64,BBBB' };
  expect(visibleWorkspace({ ...saved, input }, inactiveWorkspace(saved))).toEqual({
    result: null,
    input,
  });
});

it('shows a recognition completed during this panel session', () => {
  const result = { ...scan, id: 'new-scan', edited: '$y=3$' };
  expect(visibleWorkspace({ ...saved, result }, inactiveWorkspace(saved))).toEqual({
    result,
    input: { id: result.id, name: result.name, image: result.image },
  });
});

it('allows explicitly reopening the dismissed scan from history', () => {
  expect(visibleWorkspace(saved, { resultId: null, inputId: null })).toEqual({
    result: scan,
    input: saved.input,
  });
});

it('starts an unrecognized pending upload inactive without deleting its stored bytes', () => {
  const pending = { ...saved, result: null };
  expect(visibleWorkspace(pending, inactiveWorkspace(pending))).toEqual({
    result: null,
    input: null,
  });
  expect(pending.input?.image).toBe(scan.image);
});
