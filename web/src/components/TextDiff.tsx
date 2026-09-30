import type { CSSProperties, ReactNode } from 'react';

export type DiffOp = { op: 'same' | 'del' | 'add'; text: string };

/** Line diff by longest common subsequence: common lines stay, within each gap removed lines come before added ones. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ op: 'same', text: a[i]! });
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push({ op: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ op: 'add', text: b[j]! });
      j++;
    }
  }
  return out;
}

const BLOCK = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'MAIN',
  'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'HR',
]);
const isCode = (el: Element): boolean => el.tagName === 'PRE' || el.classList.contains('code');

/** Text of a code block, line by line as written; a `.src` caption (a block in the slide theme) gets its own line. */
function codeLines(el: Element): string[] {
  let text = '';
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      text += n.textContent ?? '';
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const child = n as Element;
    if (child.tagName === 'BR') {
      text += '\n';
      return;
    }
    const own = child.classList.contains('src');
    if (own && text !== '' && !text.endsWith('\n')) text += '\n';
    for (const c of Array.from(child.childNodes)) walk(c);
    if (own && !text.endsWith('\n')) text += '\n';
  };
  for (const c of Array.from(el.childNodes)) walk(c);
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  return lines;
}

/**
 * Plain text of a slide body, one entry per line: tags stripped, block elements and `<br>` break lines,
 * whitespace collapsed, empty lines dropped. Code blocks (`pre`, `.code`) keep their lines verbatim.
 */
export function plainText(html: string): string[] {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  const lines: string[] = [];
  let cur = '';
  const flush = (): void => {
    const t = cur.replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
    cur = '';
  };
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      cur += n.textContent ?? '';
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE') return;
    if (el.tagName === 'BR') {
      flush();
      return;
    }
    if (isCode(el)) {
      flush();
      lines.push(...codeLines(el));
      return;
    }
    const block = BLOCK.has(el.tagName);
    if (block) flush();
    for (const c of Array.from(el.childNodes)) walk(c);
    if (block) flush();
  };
  walk(doc.body);
  flush();
  return lines;
}

/** Unchanged lines kept on each side of an edit; longer unchanged runs fold. */
const CONTEXT = 2;

type Row = { kind: 'line'; op: DiffOp['op']; text: string } | { kind: 'fold'; count: number };

function fold(ops: DiffOp[]): Row[] {
  const rows: Row[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.op !== 'same') {
      rows.push({ kind: 'line', ...ops[k]! });
      k++;
      continue;
    }
    let end = k;
    while (end < ops.length && ops[end]!.op === 'same') end++;
    const run = ops.slice(k, end);
    const head = k > 0 ? CONTEXT : 0;
    const tail = end < ops.length ? CONTEXT : 0;
    const hidden = run.length - head - tail;
    if (hidden < 2) {
      for (const o of run) rows.push({ kind: 'line', ...o });
    } else {
      for (const o of run.slice(0, head)) rows.push({ kind: 'line', ...o });
      rows.push({ kind: 'fold', count: hidden });
      for (const o of run.slice(run.length - tail)) rows.push({ kind: 'line', ...o });
    }
    k = end;
  }
  return rows;
}

const lineStyle = (op: DiffOp['op']): CSSProperties => ({
  display: 'flex',
  gap: 10,
  padding: '1px 10px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  // --warn and --accent may share a hue: the sign and the strike keep removed and added lines apart.
  ...(op === 'del'
    ? { color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 9%, transparent)', textDecoration: 'line-through' }
    : op === 'add'
      ? { color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 6%, transparent)', fontWeight: 600, boxShadow: 'inset 3px 0 0 var(--accent)' }
      : { color: 'var(--grey)' }),
});
const SIGN: Record<DiffOp['op'], string> = { same: ' ', del: '−', add: '+' };

export interface TextDiffProps {
  /** Which field this is, eg "body" or "title". */
  label: string;
  before: readonly string[];
  after: readonly string[];
}

/** Line diff of one text field: removed lines struck in --warn, added ones in the accent, long unchanged runs folded. */
export function TextDiff({ label, before, after }: TextDiffProps) {
  const ops = diffLines(before, after);
  const changed = ops.some((o) => o.op !== 'same');
  let body: ReactNode;
  if (!changed) body = <p className="muted" style={{ margin: 0, padding: '4px 10px', fontSize: 12 }}>no text change</p>;
  else {
    body = fold(ops).map((r, i) =>
      r.kind === 'fold' ? (
        <div key={i} data-testid="diff-fold" className="muted" style={{ padding: '2px 10px', fontSize: 11, fontStyle: 'italic' }}>
          {r.count} unchanged lines
        </div>
      ) : (
        <div key={i} data-testid="diff-line" data-op={r.op} data-text={r.text} style={lineStyle(r.op)}>
          <span aria-hidden style={{ flex: '0 0 auto', width: 10, textDecoration: 'none', display: 'inline-block' }}>{SIGN[r.op]}</span>
          <span>{r.text === '' ? ' ' : r.text}</span>
        </div>
      ),
    );
  }
  return (
    <section data-testid="text-diff" data-field={label} aria-label={`${label} changes`} style={{ border: '1px solid var(--line)', borderRadius: 8, background: 'var(--card)', overflow: 'hidden' }}>
      <header style={{ padding: '6px 10px', fontSize: 12, fontWeight: 700, color: 'var(--grey)', borderBottom: '1px solid var(--line)' }}>{label}</header>
      <div className="mono" style={{ fontSize: 12, lineHeight: 1.55, padding: '4px 0' }}>{body}</div>
    </section>
  );
}
