import { describe, expect, it } from 'vitest';
import {
  parseCorpusOptions,
  checkCorpusProtocol,
  checkImportedCase,
} from '../scripts/lib/corpus-version.mjs';

describe('corpus version boundaries', () => {
  it('requires imported references and pixels to match their frozen parent', () => {
    const parent = {
      id: 'old',
      split: 'heldout',
      image: { sha256: 'pixels', width: 30, height: 20 },
      reference: { segments: [{ kind: 'math', latex: 'x_i' }] },
    };
    const imported = {
      ...parent,
      split: 'development',
      origin: { caseId: 'old', manifestSha256: 'parent', originalSplit: 'heldout' },
    };
    expect(() => checkImportedCase(imported, parent, 'parent')).not.toThrow();
    expect(() =>
      checkImportedCase(
        { ...imported, reference: { segments: [{ kind: 'math', latex: 'x_j' }] } },
        parent,
        'parent',
      ),
    ).toThrow(/reference/i);
    expect(() =>
      checkImportedCase(
        { ...imported, image: { ...parent.image, sha256: 'changed' } },
        parent,
        'parent',
      ),
    ).toThrow(/image|pixel/i);
    expect(() => checkImportedCase(imported, parent, 'other')).toThrow(/lineage/i);
  });
  it('defaults to v1 and consumes an explicit safe version directory', () => {
    expect(parseCorpusOptions(['--frozen'])).toEqual({
      directory: 'tests/corpus',
      args: ['--frozen'],
    });
    expect(parseCorpusOptions(['--corpus', 'tests/corpus-v2', '--frozen'])).toEqual({
      directory: 'tests/corpus-v2',
      args: ['--frozen'],
    });
    expect(() => parseCorpusOptions(['--corpus'])).toThrow(/missing/i);
    expect(() => parseCorpusOptions(['--corpus', '../outside'])).toThrow(/tests/i);
    expect(() => parseCorpusOptions(['--corpus', 'tests/../public'])).toThrow(/tests/i);
    expect(() =>
      parseCorpusOptions(['--corpus', 'tests/corpus-v2', '--corpus', 'tests/corpus']),
    ).toThrow(/duplicate/i);
  });
  it('checks exact counts, document-family separation, and evaluated lineage', () => {
    const manifest = {
      version: 2,
      protocol: {
        expected: {
          development: { equation: 1, mixed: 1, text: 0 },
          heldout: { equation: 1, mixed: 0, text: 0 },
        },
        minFamilies: 3,
      },
      cases: [
        {
          id: 'old',
          kind: 'equation',
          split: 'development',
          documentId: 'old-paper',
          origin: {
            manifestSha256: 'a'.repeat(64),
            caseId: 'old',
            originalSplit: 'heldout',
            previouslyEvaluated: true,
          },
        },
        { id: 'new-dev', kind: 'mixed', split: 'development', documentId: 'new-paper' },
        { id: 'fresh', kind: 'equation', split: 'heldout', documentId: 'fresh-paper' },
      ],
    };
    expect(() => checkCorpusProtocol(manifest)).not.toThrow();
    expect(() => checkCorpusProtocol({ ...manifest, cases: manifest.cases.slice(1) })).toThrow(
      /count/i,
    );
    expect(() =>
      checkCorpusProtocol({
        ...manifest,
        cases: manifest.cases.map((c) =>
          c.id === 'fresh' ? { ...c, origin: manifest.cases[0].origin } : c,
        ),
      }),
    ).toThrow(/fresh|evaluated/i);
    expect(() =>
      checkCorpusProtocol({
        ...manifest,
        cases: manifest.cases.map((c) =>
          c.id === 'old' ? { ...c, origin: { previouslyEvaluated: true } } : c,
        ),
      }),
    ).toThrow(/lineage/i);
    expect(() =>
      checkCorpusProtocol({
        ...manifest,
        cases: manifest.cases.map((c) =>
          c.id === 'fresh' ? { ...c, documentId: 'new-paper' } : c,
        ),
      }),
    ).toThrow(/family|split/i);
  });
});
