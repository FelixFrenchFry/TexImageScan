import { describe, expect, it } from 'vitest';
import { renderMathSvg } from '../src/math-svg';

describe('portable rendered math', () => {
  it('exports fraction and radical glyphs as standalone vector paths', () => {
    const svg = renderMathSvg('\\frac{\\sqrt{x_i}}{2}', true);
    expect(svg).toContain('<svg');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox=');
    expect(svg).toContain('<path');
    expect(svg).not.toMatch(/<foreignObject|<image|<use|@font-face|https?:\/\/(?!www\.w3\.org)/);
  });

  it('preserves matrices, sums and bold symbols without external glyph references', () => {
    const svg = renderMathSvg(
      '\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix} \\sum_{i=0}^{n}\\boldsymbol{x}_i',
      true,
    );
    expect(svg.match(/<path/g)?.length).toBeGreaterThan(8);
    expect(svg).not.toContain('href=');
  });

  it('rejects invalid math before exporting', () => {
    expect(() => renderMathSvg('\\frac{', false)).toThrow();
  });

  it('never exports executable commands or links from recognized text', () => {
    const svg = renderMathSvg('\\href{javascript:alert(1)}{click}', false);
    expect(svg).not.toMatch(/<script|<a\b|href=|javascript:/);
  });
});
