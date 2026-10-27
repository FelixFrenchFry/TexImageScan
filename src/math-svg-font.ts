import { MathJaxTexFont } from '@mathjax/mathjax-tex-font/mjs/svg.js';

// MathJax imports a default font even when fontData is provided
// replace the unused default to avoid bundling two fonts
export const Font = { fontName: 'mathjax-tex', DefaultFont: MathJaxTexFont };
