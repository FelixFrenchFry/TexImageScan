import katex from 'katex';

type PreviewPart =
  | { kind: 'text'; source: string }
  | { kind: 'math'; source: string; display: boolean };

export function splitMath(source: string): PreviewPart[] {
  const parts: PreviewPart[] = [];
  const expression = /(?<!\\)(```(?:latex|tex|math)[ \t]*\r?\n|\$\$|\$|\\\[|\\\()/g;
  let start = 0;
  for (let match = expression.exec(source); match; match = expression.exec(source)) {
    const opening = match[0];
    const fence = opening.startsWith('```');
    const closing = fence ? '```' : opening === '\\[' ? '\\]' : opening === '\\(' ? '\\)' : opening;
    const bodyStart = match.index + opening.length;
    let end = source.indexOf(closing, bodyStart);
    while (end > 0 && source[end - 1] === '\\' && closing.startsWith('$'))
      end = source.indexOf(closing, end + closing.length);
    if (end < 0) continue;
    if (match.index > start) parts.push({ kind: 'text', source: source.slice(start, match.index) });
    let body = source.slice(bodyStart, end);
    if (fence) body = body.trim();
    // a bare row separator needs a math environment to render as several equations
    if (/\\\\\s/.test(body) && !body.includes('\\begin{'))
      body = `\\begin{gathered}${body}\\end{gathered}`;
    parts.push({
      kind: 'math',
      source: body,
      display: fence || opening === '$$' || opening === '\\[',
    });
    start = end + closing.length;
    expression.lastIndex = start;
  }
  if (start < source.length) parts.push({ kind: 'text', source: source.slice(start) });
  return parts;
}

export function renderMath(
  source: string,
  display: boolean,
): { kind: 'html'; html: string } | { kind: 'error'; message: string } {
  try {
    return {
      kind: 'html',
      html: katex.renderToString(source, {
        displayMode: display,
        trust: false,
        strict: 'error',
        throwOnError: true,
        maxExpand: 200,
        maxSize: 20,
      }),
    };
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : 'Cannot preview this expression',
    };
  }
}
