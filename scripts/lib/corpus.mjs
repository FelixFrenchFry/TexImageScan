import katex from 'katex';
import { DOMParser } from 'linkedom';

export const normalizeText = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < b.length; j++)
      row.push(Math.min(row[j] + 1, previous[j + 1] + 1, previous[j] + (a[i] === b[j] ? 0 : 1)));
    previous = row;
  }
  return previous[b.length];
}

function proseScore(reference, output) {
  const a = normalizeText(reference),
    b = normalizeText(output);
  const characters = [...a],
    words = a ? a.split(' ') : [];
  const charEdits = distance(characters, [...b]),
    wordEdits = distance(words, b ? b.split(' ') : []);
  return {
    exact: a === b,
    charEdits,
    characters: characters.length,
    cer: characters.length ? charEdits / characters.length : null,
    wordEdits,
    words: words.length,
    wer: words.length ? wordEdits / words.length : null,
    compactExact: a.replaceAll(' ', '') === b.replaceAll(' ', ''),
  };
}

function proseAroundMath(reference, output) {
  const slots = (segments) => {
    const result = [''];
    for (const segment of segments) {
      if (segment.kind === 'text') result[result.length - 1] += segment.text;
      else result.push('');
    }
    return result;
  };
  const a = slots(reference),
    b = slots(output),
    scores = a.map((text, index) => proseScore(text, b[index] ?? ''));
  const total = {
    exact: scores.every((s) => s.exact),
    compactExact: scores.every((s) => s.compactExact),
    charEdits: 0,
    characters: 0,
    wordEdits: 0,
    words: 0,
  };
  for (const score of scores)
    for (const key of ['charEdits', 'characters', 'wordEdits', 'words']) total[key] += score[key];
  return {
    ...total,
    cer: total.characters ? total.charEdits / total.characters : null,
    wer: total.words ? total.wordEdits / total.words : null,
  };
}

// ignore presentation attributes while retaining font variants, accents, operators,
// script arity, fraction grouping and matrix cell order
// MediaWiki omits automatic align numbering
// keep rows, columns and explicit tags when normalizing the environment
export const comparisonSource = (latex) =>
  latex.replace(/\\(begin|end)\{align\*?\}/g, '\\$1{aligned}');

function mathTree(latex, display = false) {
  const source = comparisonSource(latex);
  const html = katex.renderToString(source, {
    output: 'mathml',
    displayMode: display,
    throwOnError: true,
    strict: 'ignore',
    trust: false,
  });
  const document = new DOMParser().parseFromString(html, 'text/html');
  function visit(node) {
    let tag = node.localName;
    if (tag === 'annotation' || tag === 'mspace') return null;
    const children = [...node.children].map(visit).filter((x) => x !== null);
    const attrs = {};
    for (const name of [
      'mathvariant',
      'accent',
      'accentunder',
      'notation',
      'linethickness',
      'bevelled',
    ])
      if (node.hasAttribute(name)) attrs[name] = node.getAttribute(name);
    if (['munder', 'mover', 'munderover'].includes(tag)) {
      const base = node.firstElementChild;
      if (
        base?.localName === 'mo' &&
        (base.getAttribute('movablelimits') === 'true' || /^[∑∏∐⋂⋃∫∬∭∮]$/.test(base.textContent))
      ) {
        tag = { munder: 'msub', mover: 'msup', munderover: 'msubsup' }[tag];
        if (attrs.accent === 'false') delete attrs.accent;
        if (attrs.accentunder === 'false') delete attrs.accentunder;
      }
    }
    if (
      tag === 'math' ||
      tag === 'semantics' ||
      (tag === 'mstyle' && !Object.keys(attrs).length) ||
      tag === 'mrow'
    )
      return children.length === 1 ? children[0] : ['group', children];
    if (['mi', 'mn', 'mo', 'mtext'].includes(tag))
      return [tag, attrs, node.textContent.normalize('NFC').replaceAll('\u00a0', ' ')];
    return [tag, attrs, children];
  }
  return JSON.stringify(visit(document.querySelector('math')));
}

export function compareMath(reference, output, display = false) {
  let expected, actual, referenceError, outputError;
  try {
    expected = mathTree(reference, display);
  } catch (error) {
    referenceError = String(error);
  }
  try {
    actual = mathTree(output, display);
  } catch (error) {
    outputError = String(error);
  }
  const tokenize = (text) => text.match(/\\[a-zA-Z]+|\\.|[^\s]/gu) ?? [];
  const a = tokenize(reference),
    b = tokenize(output);
  const tokenEdits = distance(a, b);
  return {
    rawExact: reference.trim() === output.trim(),
    structuralMatch: !!expected && expected === actual,
    referenceRenderable: !!expected,
    outputRenderable: !!actual,
    referenceError,
    outputError,
    tokenEdits,
    tokens: a.length,
    tokenErrorRate: a.length ? tokenEdits / a.length : null,
  };
}

function splitOutput(source, equation) {
  let text = source.trim();
  const fence = text.match(/^```(?:latex|math|tex)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  const segments = [],
    flags = [];
  const escaped = (index) => {
    let n = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) n++;
    return n % 2 === 1;
  };
  let start = 0,
    index = 0;
  while (index < text.length) {
    let open, close;
    if (text[index] === '$' && !escaped(index)) {
      open = text.startsWith('$$', index) ? '$$' : '$';
      close = open;
    } else if (text[index] === '\\' && !escaped(index) && ['(', '['].includes(text[index + 1])) {
      open = text.slice(index, index + 2);
      close = open === '\\(' ? '\\)' : '\\]';
    }
    if (!open) {
      index++;
      continue;
    }
    if (index > start)
      segments.push({ kind: 'text', text: text.slice(start, index).replaceAll('\\$', '$') });
    let end = index + open.length;
    while (end < text.length && !(text.startsWith(close, end) && !escaped(end))) end++;
    if (end === text.length) {
      flags.push('unmatched-delimiter');
      segments.push({ kind: 'text', text: text.slice(index) });
      start = text.length;
      break;
    }
    segments.push({
      kind: 'math',
      latex: text.slice(index + open.length, end),
      display: open === '$$' || open === '\\[',
    });
    index = end + close.length;
    start = index;
  }
  if (start < text.length)
    segments.push({ kind: 'text', text: text.slice(start).replaceAll('\\$', '$') });
  if (equation && !segments.some((s) => s.kind === 'math') && !flags.length)
    return { segments: [{ kind: 'math', latex: text, display: true }], flags };
  return { segments, flags };
}

export function scoreCase(sample, outcome) {
  if (outcome.status !== 'success')
    return { scored: false, pass: false, reason: outcome.status, flags: [] };
  const expected = sample.reference?.segments;
  if (!['source-checked', 'approved'].includes(sample.reference?.status) || !expected?.length)
    return { scored: false, pass: false, reason: 'reference-unavailable', flags: [] };
  const { segments, flags } = splitOutput(outcome.output, sample.kind === 'equation');
  const a = expected.filter((s) => s.kind === 'math'),
    b = segments.filter((s) => s.kind === 'math');
  if (a.length !== b.length) flags.push('math-span-count');
  if (outcome.truncated) flags.push('truncated');
  if (!outcome.output.trim()) flags.push('empty-output');
  const math = a.map((span, index) => ({
    ...compareMath(span.latex, b[index]?.latex ?? '', span.display),
    missing: !b[index],
  }));
  if (math.some((span) => !span.referenceRenderable)) flags.push('unsupported-reference');
  // exclude math placeholders from prose scores
  const proseReference = expected.some((s) => s.kind === 'text');
  const canScoreProse =
    proseReference && a.length === b.length && !flags.includes('unmatched-delimiter');
  const text = canScoreProse ? proseAroundMath(expected, segments) : null;
  if (!proseReference && segments.some((s) => s.kind === 'text' && s.text.trim()))
    flags.push('unexpected-prose');
  const scored = !flags.includes('unsupported-reference');
  return {
    scored,
    pass:
      scored &&
      !flags.length &&
      (!proseReference || !!text?.exact) &&
      math.every((s) => s.structuralMatch),
    prose: text,
    math,
    flags,
    reason: scored ? null : 'unsupported-reference',
    proseUnscored: proseReference && !canScoreProse ? 'ambiguous-math-segmentation' : null,
  };
}

export function validateManifest(manifest) {
  if (!manifest.cases?.length) throw new Error('Empty corpus');
  const ids = new Set(),
    groups = new Map();
  for (const sample of manifest.cases) {
    if (ids.has(sample.id)) throw new Error(`Duplicate id: ${sample.id}`);
    ids.add(sample.id);
    if (!['development', 'heldout', 'regression'].includes(sample.split))
      throw new Error(`Invalid split: ${sample.id}`);
    if (groups.has(sample.documentId) && groups.get(sample.documentId) !== sample.split)
      throw new Error(`Document split leakage: ${sample.documentId}`);
    groups.set(sample.documentId, sample.split);
    if (sample.expectedTask !== (sample.kind === 'equation' ? 'equation' : 'mixed'))
      throw new Error(`Invalid task: ${sample.id}`);
  }
  for (const a of manifest.cases)
    for (const b of manifest.cases) {
      if (a.id === b.id || a.sourceId !== b.sourceId || !a.evidence || !b.evidence) continue;
      if (a.evidence.html.includes(`data-corpus-target="${b.evidence.target}"`))
        throw new Error(`Nested original crops: ${a.id} contains ${b.id}`);
    }
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  const percentile = (p) => (sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    median: sorted.length
      ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) /
        2
      : null,
    p90: percentile(0.9),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
  };
}

export function summarize(entries) {
  if (!entries.length) throw new Error('Empty evaluation selection');
  const counts = {
    selected: entries.length,
    attempted: 0,
    success: 0,
    error: 0,
    timeout: 0,
    notRun: 0,
    scored: 0,
    passed: 0,
    truncated: 0,
    referenceUnavailable: 0,
  };
  const routing = {
    available: 0,
    correct: 0,
    unavailable: 0,
    confusion: { equation: { equation: 0, mixed: 0 }, mixed: { equation: 0, mixed: 0 } },
    reasons: {},
  };
  const prose = {
      eligibleCases: 0,
      cases: 0,
      unscoredCases: 0,
      charEdits: 0,
      characters: 0,
      wordEdits: 0,
      words: 0,
    },
    math = { spans: 0, rawExact: 0, structuralMatch: 0, outputRenderable: 0, unscorable: 0 };
  const layout = [],
    total = [],
    remaining = [],
    wall = [];
  const scoredEntries = [];
  for (const entry of entries) {
    const { sample, outcome } = entry;
    const score = scoreCase(sample, outcome);
    scoredEntries.push({ ...entry, score });
    if (outcome.status === 'not-run') {
      counts.notRun++;
      continue;
    }
    counts.attempted++;
    if (outcome.status !== 'success') {
      counts[outcome.status === 'timeout' ? 'timeout' : 'error']++;
      continue;
    }
    counts.success++;
    if (outcome.truncated) counts.truncated++;
    if (sample.reference?.segments?.some((s) => s.kind === 'text')) {
      prose.eligibleCases++;
      if (!score.prose) prose.unscoredCases++;
    }
    if (score.scored) counts.scored++;
    else counts.referenceUnavailable++;
    if (score.pass) counts.passed++;
    if (['equation', 'mixed'].includes(outcome.task)) {
      routing.available++;
      routing.confusion[sample.expectedTask][outcome.task]++;
      if (sample.expectedTask === outcome.task) routing.correct++;
    } else routing.unavailable++;
    if (outcome.routing) {
      routing.reasons[outcome.routing.reason] = (routing.reasons[outcome.routing.reason] ?? 0) + 1;
      layout.push(outcome.routing.elapsedMs);
    }
    total.push(outcome.elapsedMs);
    wall.push(outcome.wallMs);
    if (Number.isFinite(outcome.elapsedMs) && Number.isFinite(outcome.routing?.elapsedMs))
      remaining.push(outcome.elapsedMs - outcome.routing.elapsedMs);
    if (score.prose) {
      prose.cases++;
      for (const key of ['charEdits', 'characters', 'wordEdits', 'words'])
        prose[key] += score.prose[key];
    }
    for (const span of score.math ?? []) {
      if (!span.referenceRenderable) {
        math.unscorable++;
        continue;
      }
      math.spans++;
      if (span.rawExact) math.rawExact++;
      if (span.structuralMatch) math.structuralMatch++;
      if (span.outputRenderable) math.outputRenderable++;
    }
  }
  return {
    complete: counts.notRun === 0,
    counts,
    routing,
    prose: {
      ...prose,
      cer: prose.characters ? prose.charEdits / prose.characters : null,
      wer: prose.words ? prose.wordEdits / prose.words : null,
    },
    math,
    latencyMs: {
      layout: distribution(layout),
      total: distribution(total),
      remainingPipeline: distribution(remaining),
      wall: distribution(wall),
    },
    cases: scoredEntries.map(({ sample, outcome, score }) => ({
      id: sample.id,
      documentId: sample.documentId,
      split: sample.split,
      kind: sample.kind,
      publisher: sample.publisher,
      outcome,
      score,
    })),
  };
}
