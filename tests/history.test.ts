import { expect, it } from 'vitest';
import { combineScans, historyEntry, removeScans } from '../src/history';
import { initialState } from '../src/state';
import { type RecognitionResult } from '../src/protocol';

export const scan: RecognitionResult = {
  id: 'first',
  name: 'equation.png',
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

it('combines edited scans chronologically and strips only standalone math delimiters for LaTeX', () => {
  const second = {
    ...scan,
    id: 'second',
    createdAt: '2026-10-24T11:00:00Z',
    edited: 'Energy $E=mc^2$.',
  };
  expect(combineScans([second, scan], 'markdown')).toBe('$x=2$\n\nEnergy $E=mc^2$.');
  expect(combineScans([second, scan], 'latex')).toBe('x=2\n\nEnergy $E=mc^2$.');
  expect(combineScans([{ ...scan, edited: '```latex\nx=1 \\\\\ny=2\n```' }], 'latex')).toBe(
    'x=1 \\\\\ny=2',
  );
  expect(combineScans([{ ...scan, edited: '$x$ and $y$' }], 'latex')).toBe('$x$ and $y$');
});

it('summaries carry a bounded edited excerpt without image or full OCR payloads', () => {
  const summary = historyEntry({ ...scan, edited: 'a'.repeat(1000) });
  expect(summary).toEqual({
    id: scan.id,
    name: scan.name,
    createdAt: scan.createdAt,
    preview: 'a'.repeat(160),
    edited: true,
    truncated: false,
  });
});

it('deleting an opened scan clears only its owned input and preserves independent sources', () => {
  const input = { id: 'pending', name: 'new.png', image: 'data:image/png;base64,BBBB' };
  const state = { ...initialState(), result: scan, input, history: [historyEntry(scan)] };
  expect(removeScans(state, [scan.id])).toMatchObject({ result: null, input, history: [] });
  expect(
    removeScans({ ...state, input: { ...input, id: scan.id, image: scan.image } }, [scan.id]).input,
  ).toBeNull();
  const identical = { ...input, image: scan.image };
  expect(removeScans({ ...state, input: identical }, [scan.id]).input).toEqual(identical);
  expect(removeScans(state, ['other']).result).toEqual(scan);
});
