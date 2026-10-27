import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { browserExecutable } from '../scripts/browser.mjs';
import { collectCandidates, removeCaptureExclusions } from '../scripts/lib/corpus-candidates.mjs';

let browser, page;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
});
afterAll(async () => {
  await browser?.close();
});
it('captures complete native equation rows, preserving both sides and every row', async () => {
  await page.setContent(
    `<article><table class="ltx_equationgroup ltx_eqn_table"><tr><td><math alttext="h_t"><mi>h</mi></math></td><td><math alttext="=Ah_{t-1}+Bx_t"><mo>=</mo><mi>A</mi><mi>h</mi><mo>+</mo><mi>B</mi><mi>x</mi></math></td></tr><tr><td><math alttext="y_t"><mi>y</mi></math></td><td><math alttext="=C^\\top h_t"><mo>=</mo><mi>C</mi><mi>h</mi></math></td></tr></table></article>`,
  );
  const candidates = await page.evaluate(collectCandidates, { adapter: 'mathml' });
  const equations = candidates.filter((c) => c.kind === 'equation');
  expect(equations).toHaveLength(1);
  expect(equations[0].segments[0].latex).toContain('h_t');
  expect(equations[0].segments[0].latex).toContain('=Ah_{t-1}+Bx_t');
  expect(equations[0].segments[0].latex).toContain('y_t');
  expect(equations[0].segments[0].latex).toContain('=C^\\top h_t');
});
it('extracts authored inline native math and excludes invisible CSS from prose', async () => {
  await page.setContent(
    `<article><p class="ltx_p" style="width:700px">For this particular example we use the vector <math alttext="\\boldsymbol{x}_i"><mi>x</mi><mi>i</mi></math> to describe the state of the system at the current time and then compare its value with the previous observation.<style>.hidden-reference-noise {color:red}</style></p></article>`,
  );
  const candidates = await page.evaluate(collectCandidates, { adapter: 'mathml' });
  const mixed = candidates.find((c) => c.kind === 'mixed');
  expect(mixed.reference).toBeUndefined();
  expect(mixed.segments.filter((s) => s.kind === 'math')).toEqual([
    { kind: 'math', latex: '\\boldsymbol{x}_i', display: false },
  ]);
  expect(JSON.stringify(mixed.segments)).not.toContain('hidden-reference-noise');
});
it('rejects equations painted outside a collapsed ancestor clipping box', async () => {
  await page.setContent(
    `<article><div style="width:700px;height:8px;overflow:hidden;font-size:30px"><math display="block" alttext="x_i = \\sum_j A_j W_{ij}"><mi>x</mi><mo>=</mo><mi>A</mi><mi>W</mi></math></div></article>`,
  );
  const candidates = await page.evaluate(collectCandidates, { adapter: 'mathml' });
  expect(candidates.filter((c) => c.kind === 'equation')).toHaveLength(0);
});
it('removes tooltip footnotes and generated citation widgets before image and reference extraction', async () => {
  await page.setContent(
    '<d-article style="display:block;width:700px"><p>This paragraph contains enough ordinary words to become a text sample and describes the method used for a simple example in this article.<d-footnote>Invisible explanatory material should never enter the reference.</d-footnote><d-cite key="source"></d-cite></p></d-article>',
  );
  await page.evaluate(removeCaptureExclusions);
  expect(await page.locator('d-footnote,d-cite').count()).toBe(0);
  const candidates = await page.evaluate(collectCandidates, { adapter: 'katex' });
  expect(candidates).toHaveLength(1);
  expect(JSON.stringify(candidates)).not.toContain('Invisible explanatory');
});
it('excludes generated figure captions and notebook controls from document prose', async () => {
  await page.setContent(
    '<d-article style="display:block;width:700px"><p class="figcaption">15: This caption describes a generated illustration and contains enough words to look like an ordinary paragraph, but it also has a notebook control.<a class="colab-root">Reproduce in a Notebook</a></p></d-article>',
  );
  expect(await page.evaluate(collectCandidates, { adapter: 'katex' })).toEqual([]);
});
it('includes overflowing MathJax glyph boxes when computing the screenshot clip', async () => {
  await page.setContent(
    '<span class="MathJax" style="display:inline-block;width:100px;height:20px;position:relative"><span style="position:absolute;left:50px;top:16px;width:35px;height:12px">index</span></span>',
  );
  const { captureBounds } = await import('../scripts/lib/corpus-candidates.mjs');
  const bounds = await page.locator('.MathJax').evaluate(captureBounds);
  expect(bounds.height).toBeGreaterThan(20);
  expect(bounds.height).toBeLessThan(40);
  expect(bounds.width).toBe(100);
});
