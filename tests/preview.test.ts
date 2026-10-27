import { describe, expect, it } from 'vitest';
import { splitMath, renderMath } from '../src/preview';

describe('math preview', () => {
  it('preserves prose and distinguishes inline and display math', () => {
    expect(splitMath('Energy $E=mc^2$.\n$$x=1$$')).toEqual([
      { kind: 'text', source: 'Energy ' },
      { kind: 'math', source: 'E=mc^2', display: false },
      { kind: 'text', source: '.\n' },
      { kind: 'math', source: 'x=1', display: true },
    ]);
  });

  it('keeps unmatched delimiters and escaped dollar signs literal', () => {
    expect(splitMath('Cost \\$5 and $unfinished')).toEqual([
      { kind: 'text', source: 'Cost \\$5 and $unfinished' },
    ]);
  });

  it('rejects unsafe commands and preserves an invalid formula as an error', () => {
    expect(renderMath('\\frac{', false).kind).toBe('error');
    const link = renderMath('\\href{javascript:alert(1)}{click}', false);
    expect(JSON.stringify(link)).not.toContain('href="javascript:');
  });

  it('renders the LaTeX fences the real model emits, including multiline equations', () => {
    const parts = splitMath('```latex\nx=1 \\\\\ny=2\n```');
    expect(parts).toHaveLength(1);
    expect(parts[0]?.kind).toBe('math');
    const part = parts[0];
    if (!part || part.kind !== 'math') throw new Error('Expected a formula');
    expect(renderMath(part.source, part.display).kind).toBe('html');
  });
});
