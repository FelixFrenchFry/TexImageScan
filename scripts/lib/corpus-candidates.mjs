// extract references from the original author markup
export function removeCaptureExclusions() {
  document
    .querySelectorAll(
      '.reference,.mw-editsection,mjx-labels,.ltx_tag_equation,.ltx_eqn_eqno,.eqno,.MathJax .MathJax_MathML,d-footnote,d-cite',
    )
    .forEach((node) => node.remove());
}

// MathJax can paint scripts outside the inline layout box
// include text ranges instead of oversized layout struts

export function captureBounds(element) {
  const boxes = [element.getBoundingClientRect()],
    walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim() || getComputedStyle(node.parentElement).visibility !== 'visible')
      continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) if (rect.width && rect.height) boxes.push(rect);
  }
  const nominal = boxes[0];
  const left = Math.floor(nominal.left + scrollX),
    top = Math.floor(Math.min(...boxes.map((box) => box.top)) + scrollY);
  const right = Math.ceil(nominal.right + scrollX),
    bottom = Math.ceil(Math.max(...boxes.map((box) => box.bottom)) + scrollY);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function collectCandidates({
  adapter,
  includeInlineEquations = false,
  excludeNumberedEquations = false,
}) {
  const mathSources = new Map();
  if (adapter === 'mathjax')
    for (const item of window.MathJax.startup.document.math) {
      if (item.typesetRoot)
        mathSources.set(item.typesetRoot, { latex: item.math, display: item.display });
    }
  if (adapter === 'mathjax2')
    for (const item of window.MathJax.Hub.getAllJax()) {
      const root = document.getElementById(`${item.inputID}-Frame`);
      if (root)
        mathSources.set(root, {
          latex: item.originalText,
          display: !!root.closest('.MathJax_Display') || item.root?.display === 'block',
        });
    }
  if (adapter === 'katex')
    for (const root of document.querySelectorAll('.katex')) {
      const latex = root.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (latex)
        mathSources.set(root, {
          latex,
          display:
            !!root.closest('.katex-display') ||
            root.querySelector('math')?.getAttribute('display') === 'block',
        });
    }
  if (adapter === 'mathml') {
    const equationSelector = '.ltx_equation, .ltx_equationgroup';
    for (const root of document.querySelectorAll('math[alttext]'))
      if (!root.closest(equationSelector))
        mathSources.set(root, {
          latex: root.getAttribute('alttext'),
          display: root.getAttribute('display') === 'block',
        });
    for (const root of document.querySelectorAll(equationSelector)) {
      if (root.parentElement.closest(equationSelector)) continue;
      const rows = root.matches('table')
        ? [...root.querySelectorAll('tr')].filter((row) => row.closest('table') === root)
        : [root];
      const expressions = [];
      let supported = true;
      for (const row of rows) {
        const cells = row.matches('tr')
          ? [...row.children].filter((cell) => cell.matches('td,th'))
          : [row];
        const parts = [];
        for (const cell of cells) {
          const maths = [...cell.querySelectorAll('math[alttext]')];
          const clone = cell.cloneNode(true);
          clone
            .querySelectorAll('math,script,style,.ltx_tag_equation,.ltx_eqn_eqno')
            .forEach((node) => node.remove());
          const residue = clone.textContent.trim();
          if (!/^[\s,.;:()[\]]*$/.test(residue)) {
            supported = false;
            break;
          }
          if (maths.length)
            parts.push(maths.map((math) => math.getAttribute('alttext')).join(' ') + residue);
        }
        if (parts.length) expressions.push(parts.join(' & '));
      }
      if (supported && expressions.length) {
        const body = expressions.join(' \\\\ ');
        const latex =
          expressions.length > 1 || body.includes(' & ')
            ? `\\begin{aligned}${body}\\end{aligned}`
            : body;
        mathSources.set(root, { latex, display: true });
      }
    }
  }
  if (adapter === 'wiki')
    for (const element of document.querySelectorAll('.mwe-math-element')) {
      const image = element.querySelector('img');
      if (!image) continue;
      let latex =
        element.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? image.alt;
      try {
        latex = JSON.parse(element.getAttribute('data-mw'))?.body?.extsrc ?? latex;
      } catch {}
      mathSources.set(element, {
        latex,
        display: image.classList.contains('mwe-math-fallback-image-display'),
      });
    }
  const selector =
    adapter === 'wiki'
      ? '.mw-parser-output p'
      : adapter === 'mathml'
        ? 'p.ltx_p'
        : 'main p, article p, section p, .section p, #artText p, d-article p';
  const output = [];
  function add(element, kind, segments, mathRoot) {
    const bounds = element.getBoundingClientRect();
    if (bounds.width < 30 || bounds.height < 12 || bounds.width > 1100 || bounds.height > 330)
      return;
    const table = element.closest('table');
    if (
      table &&
      !(mathRoot && adapter === 'mathml' && table.matches('.ltx_equation,.ltx_equationgroup'))
    )
      return;
    if (
      element.closest(
        'figure,figcaption,d-figure,d-figure-caption,.caption,.figcaption,.sidebar,.infobox,.reflist,.reference-list,.abstract',
      ) &&
      adapter !== 'prose'
    )
      return;
    if (
      getComputedStyle(element).visibility !== 'visible' ||
      getComputedStyle(element).display === 'none'
    )
      return;
    // a collapsed disclosure can clip a child that still has layout bounds
    // reject clipping by content ancestors before applying the page scroll offset
    for (
      let ancestor = element.parentElement;
      ancestor && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor),
        rect = ancestor.getBoundingClientRect();
      const clips = (value) => ['hidden', 'clip', 'auto', 'scroll'].includes(value);
      const left = rect.left + ancestor.clientLeft,
        top = rect.top + ancestor.clientTop;
      if (
        clips(style.overflowX) &&
        (bounds.left < left - 1 || bounds.right > left + ancestor.clientWidth + 1)
      )
        return;
      if (
        clips(style.overflowY) &&
        (bounds.top < top - 1 || bounds.bottom > top + ancestor.clientHeight + 1)
      )
        return;
    }
    if (!mathRoot)
      for (const math of element.querySelectorAll(
        'img,mjx-container,math[alttext],.katex,.MathJax',
      )) {
        const r = math.getBoundingClientRect();
        if (
          r.width &&
          r.height &&
          (r.left < bounds.left - 1 ||
            r.right > bounds.right + 1 ||
            r.top < bounds.top - 1 ||
            r.bottom > bounds.bottom + 1)
        )
          return;
      }
    // reject paragraph bounds that extend under floats
    if (!mathRoot)
      for (const image of document.querySelectorAll(
        'img, figure, table, aside, .infobox, .sidebar, .vertical-navbox, h1, h2, h3, h4, h5, h6',
      )) {
        if (element.contains(image)) continue;
        const r = image.getBoundingClientRect();
        if (
          r.width > 20 &&
          r.height > 20 &&
          Math.min(r.right, bounds.right) - Math.max(r.left, bounds.left) > 2 &&
          Math.min(r.bottom, bounds.bottom) - Math.max(r.top, bounds.top) > 2
        )
          return;
      }
    const id = `corpus-target-${output.length}`;
    element.setAttribute('data-corpus-target', id);
    output.push({ target: id, kind, segments, html: element.outerHTML });
  }
  const seenEquations = new Set();
  for (const [element, math] of mathSources) {
    if (!math.display && adapter !== 'wiki' && !includeInlineEquations) continue;
    if (excludeNumberedEquations && /\\begin\{equation\*?\}|\\tag\b/.test(math.latex)) continue;
    if (
      math.latex.length < 16 ||
      math.latex.length > 650 ||
      !/[=<>]|\\(?:sum|int|frac|lim|begin)/.test(math.latex)
    )
      continue;
    const key = math.latex.replace(/\s+/g, '').replace(/[.,;]+$/, '');
    if (seenEquations.has(key)) continue;
    const target =
      adapter === 'wiki'
        ? element.querySelector('img')
        : (element.querySelector('mjx-math') ?? element);
    add(target, 'equation', [{ kind: 'math', ...math }], true);
    if (target.hasAttribute('data-corpus-target')) seenEquations.add(key);
  }
  const seen = new Set();
  for (const element of document.querySelectorAll(selector)) {
    if (
      adapter === 'wiki' &&
      [...element.querySelectorAll('i,sup,sub')].some((node) => !node.closest('.mwe-math-element'))
    )
      continue;
    if (
      adapter === 'prose' &&
      (element.querySelector('i') ||
        [...element.querySelectorAll('em')].some((node) => node.textContent.trim().length < 4))
    )
      continue;
    if (
      adapter === 'prose' &&
      element.querySelector(
        'img, svg, .pretex-inline, .pretex-display, .inline-formula, .disp-formula, sup:not(.reference), sub',
      )
    )
      continue;
    if (
      adapter !== 'prose' &&
      [...element.querySelectorAll('img,svg')].some(
        (node) => ![...mathSources.keys()].some((root) => root.contains(node)),
      )
    )
      continue;
    const clone = element.cloneNode(true);
    const elements = [...mathSources].filter(([root]) => element.contains(root));
    if (
      excludeNumberedEquations &&
      elements.some(([, math]) => /\\begin\{equation\*?\}|\\tag\b/.test(math.latex))
    )
      continue;
    // replace math in the clone with markers to avoid duplicate MathML text
    for (let i = 0; i < elements.length; i++) {
      const [root] = elements[i];
      const path = [];
      let node = root;
      while (node !== element) {
        path.unshift([...node.parentNode.childNodes].indexOf(node));
        node = node.parentNode;
      }
      let copy = clone;
      for (const index of path) copy = copy.childNodes[index];
      copy.replaceWith(document.createTextNode(`\uE000${i}\uE001`));
    }
    clone.querySelectorAll('script,style,link').forEach((node) => node.remove());
    const text = clone.textContent.replace(/\s+/g, ' ').trim();
    const wordCount = text.split(' ').length;
    if (
      wordCount < (adapter === 'prose' ? 12 : 22) ||
      wordCount > 105 ||
      seen.has(text) ||
      text.includes('Copy to clipboard')
    )
      continue;
    seen.add(text);
    const segments = [];
    let start = 0;
    for (const match of text.matchAll(/\uE000(\d+)\uE001/g)) {
      if (match.index > start)
        segments.push({ kind: 'text', text: text.slice(start, match.index) });
      segments.push({ kind: 'math', ...elements[Number(match[1])][1] });
      start = match.index + match[0].length;
    }
    if (start < text.length) segments.push({ kind: 'text', text: text.slice(start) });
    if (!segments.length) continue;
    add(element, elements.length ? 'mixed' : 'text', segments, false);
  }
  return output;
}
