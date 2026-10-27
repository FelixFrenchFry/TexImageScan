import { liteAdaptor } from '@mathjax/src/mjs/adaptors/liteAdaptor.js';
import { browserAdaptor } from '@mathjax/src/mjs/adaptors/browserAdaptor.js';
import { LiteElement } from '@mathjax/src/mjs/adaptors/lite/Element.js';
import { HTMLDocument } from '@mathjax/src/mjs/handlers/html/HTMLDocument.js';
import { MathML } from '@mathjax/src/mjs/input/mathml.js';
import { SVG } from '@mathjax/src/mjs/output/svg.js';
import { MathJaxTexFont } from '@mathjax/mathjax-tex-font/mjs/svg.js';
import { renderMath } from './preview';

const options = () => ({
  InputJax: new MathML(),
  OutputJax: new SVG({
    fontCache: 'none',
    fontData: MathJaxTexFont,
    linebreaks: { inline: false },
  }),
});

function browserRenderer() {
  const adaptor = browserAdaptor();
  const renderer = new HTMLDocument(document, adaptor, options());
  return (mathml: string, display: boolean) => {
    const node = renderer.convert(mathml, { display, em: 20, ex: 8.84, containerWidth: 640 });
    if (!(node instanceof HTMLElement))
      throw new Error('This equation could not be rendered as an image.');
    const svg = node.querySelector('svg');
    if (!svg) throw new Error('This equation could not be rendered as an image.');
    return svg.outerHTML;
  };
}

function serverRenderer() {
  const adaptor = liteAdaptor();
  const renderer = new HTMLDocument(adaptor.parse(''), adaptor, options());
  return (mathml: string, display: boolean) => {
    const node = renderer.convert(mathml, { display, em: 20, ex: 8.84, containerWidth: 640 });
    if (!(node instanceof LiteElement))
      throw new Error('This equation could not be rendered as an image.');
    const svg = adaptor.tags(node, 'svg')[0];
    if (!svg) throw new Error('This equation could not be rendered as an image.');
    return adaptor.outerHTML(svg);
  };
}

// use browser font metrics for fallback Unicode text
const vector = typeof document === 'undefined' ? serverRenderer() : browserRenderer();

// render the parsed preview MathML as vector output
// use paths for math glyphs and SVG text for uncommon Unicode
export function renderMathSvg(source: string, display: boolean): string {
  const rendered = renderMath(source, display);
  if (rendered.kind === 'error')
    throw new Error('Fix the highlighted math in Edit source before exporting an image.');
  const mathml = rendered.html.match(/<math[\s\S]*?<\/math>/)?.[0];
  if (!mathml) throw new Error('This equation could not be rendered as an image.');
  return vector(mathml, display);
}
