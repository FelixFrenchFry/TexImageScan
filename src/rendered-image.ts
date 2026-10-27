import { splitMath } from './preview';

export type ImageFormat = 'png' | 'svg';
const namespace = 'http://www.w3.org/2000/svg';
const fontSize = 20;
const padding = 16;

function checkSize(width: number, height: number, scale: number) {
  if (
    !Number.isFinite(width + height) ||
    width <= 0 ||
    height <= 0 ||
    width * scale > 16_384 ||
    height * scale > 16_384 ||
    width * height * scale ** 2 > 32_000_000
  ) {
    throw new Error('Rendered image is too large. Export a shorter passage or a tighter crop.');
  }
}

export async function renderedImage(source: string, format: ImageFormat): Promise<Blob> {
  if (!source.trim()) throw new Error('There is no text to export.');
  const { renderMathSvg } = await import('./math-svg');
  await document.fonts.ready;
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:0;top:0;width:max-content;max-width:640px;visibility:hidden;pointer-events:none;white-space:pre-wrap;font:${fontSize}px/1.5 Georgia,"Times New Roman",serif;color:#000;`;
  host.setAttribute('aria-hidden', 'true');
  const words: { element: HTMLSpanElement; baseline: HTMLSpanElement; source: string }[] = [];
  const equations: SVGSVGElement[] = [];

  for (const part of splitMath(source)) {
    if (part.kind === 'text') {
      for (const token of part.source.match(/\s+|\S+/gu) ?? []) {
        if (/^\s+$/u.test(token)) {
          host.append(document.createTextNode(token));
          continue;
        }
        // a zero-sized marker measures each word baseline
        const element = document.createElement('span');
        element.style.cssText = 'display:inline-block;white-space:pre;';
        element.textContent = token;
        const baseline = document.createElement('span');
        baseline.style.cssText = 'display:inline-block;width:0;height:0;';
        element.append(baseline);
        words.push({ element, baseline, source: token });
        host.append(element);
      }
      continue;
    }
    const parsed = new DOMParser().parseFromString(
      renderMathSvg(part.source, part.display),
      'image/svg+xml',
    );
    const equation = document.importNode(parsed.documentElement, true);
    if (!(equation instanceof SVGSVGElement) || parsed.querySelector('parsererror')) {
      throw new Error('This equation could not be rendered as an image.');
    }
    const box = equation.viewBox.baseVal;
    const width = Math.max(1, (box.width * fontSize) / 1000);
    const height = Math.max(1, (box.height * fontSize) / 1000);
    checkSize(width, height, 1);
    equation.setAttribute('width', String(width));
    equation.setAttribute('height', String(height));
    equation.removeAttribute('style');
    equation.style.verticalAlign = `${(-(box.y + box.height) * fontSize) / 1000}px`;
    if (part.display) {
      const block = document.createElement('div');
      block.style.cssText = 'width:max-content;margin:12px auto;line-height:0;white-space:normal;';
      block.append(equation);
      host.append(block);
    } else host.append(equation);
    equations.push(equation);
  }

  document.body.append(host);
  let svg: SVGSVGElement;
  let width: number;
  let height: number;
  try {
    // include ink bounds for Unicode rendered with system fonts
    for (const equation of equations) {
      const view = equation.viewBox.baseVal;
      const ink = equation.getBBox();
      const x = Math.min(view.x, ink.x),
        y = Math.min(view.y, ink.y);
      const width = Math.max(view.x + view.width, ink.x + ink.width) - x;
      const height = Math.max(view.y + view.height, ink.y + ink.height) - y;
      equation.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
      equation.setAttribute('width', String(Math.max(1, (width * fontSize) / 1000)));
      equation.setAttribute('height', String(Math.max(1, (height * fontSize) / 1000)));
      equation.style.verticalAlign = `${(-(y + height) * fontSize) / 1000}px`;
    }
    // measure every node before moving it out of the host
    const positionedWords = words.map((word) => ({
      ...word,
      box: word.element.getBoundingClientRect(),
      y: word.baseline.getBoundingClientRect().top,
    }));
    const positionedEquations = equations.map((element) => ({
      element,
      box: element.getBoundingClientRect(),
    }));
    const bounds = [...positionedWords, ...positionedEquations].map((item) => item.box);
    const left = Math.min(...bounds.map((box) => box.left));
    const top = Math.min(...bounds.map((box) => box.top));
    const right = Math.max(...bounds.map((box) => box.right));
    const bottom = Math.max(...bounds.map((box) => box.bottom));
    width = Math.ceil(right - left + padding * 2);
    height = Math.ceil(bottom - top + padding * 2);
    checkSize(width, height, format === 'png' ? 2 : 1);
    svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('fill', '#000');
    svg.setAttribute('color', '#000');
    for (const word of positionedWords) {
      const box = word.box;
      const text = document.createElementNS(namespace, 'text');
      text.setAttribute('x', String(box.left - left + padding));
      text.setAttribute('y', String(word.y - top + padding));
      text.setAttribute('font-family', 'Georgia, Times New Roman, serif');
      text.setAttribute('font-size', String(fontSize));
      text.textContent = word.source;
      svg.append(text);
    }
    for (const { element: equation, box } of positionedEquations) {
      equation.setAttribute('x', String(box.left - left + padding));
      equation.setAttribute('y', String(box.top - top + padding));
      equation.removeAttribute('style');
      svg.append(equation);
    }
  } finally {
    host.remove();
  }

  const vector = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
  if (format === 'svg') return vector;
  const url = URL.createObjectURL(vector);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image rendering is unavailable. Try downloading SVG instead.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not create the PNG image. Try downloading SVG instead.'));
      }, 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadRenderedImage(blob: Blob, name: string, format: ImageFormat) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'scan'}-rendered.${format}`;
  link.click();
  // delay URL revocation until the browser starts the download
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
