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

/** Word-level diff of two lines: runs of words and the spaces between them, each kept, removed or added. */
export function diffWords(before: string, after: string): DiffOp[] {
  const tok = (t: string): string[] => t.split(/(\s+)/).filter((x) => x !== '');
  return diffLines(tok(before), tok(after));
}

/** For each removed or added line, its counterpart in the same edit (i-th removed ↔ i-th added), when there is one. */
function pairs(rows: Row[]): Map<number, number> {
  const out = new Map<number, number>();
  let k = 0;
  while (k < rows.length) {
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < rows.length && rows[k]!.kind === 'line' && (rows[k] as { op: string }).op === 'del') dels.push(k++);
    while (k < rows.length && rows[k]!.kind === 'line' && (rows[k] as { op: string }).op === 'add') adds.push(k++);
    for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
      out.set(dels[i]!, adds[i]!);
      out.set(adds[i]!, dels[i]!);
    }
    if (dels.length === 0 && adds.length === 0) k++;
  }
  return out;
}

const changed = (op: 'del' | 'add'): CSSProperties =>
  op === 'del' ? { color: 'var(--grey)', textDecoration: 'line-through' } : { color: 'var(--accent)' };

/** A removed or added line: the words it shares with its counterpart plain, only the changed words struck or in the accent. */
function Words({ op, text, other }: { op: 'del' | 'add'; text: string; other: string | undefined }) {
  if (other === undefined) return <span style={changed(op)}>{text}</span>;
  const ops = op === 'del' ? diffWords(text, other) : diffWords(other, text);
  return (
    <>
      {ops.map((w, i) =>
        w.op === 'same' ? <span key={i}>{w.text}</span> : w.op === op ? <span key={i} style={/^\s+$/.test(w.text) ? undefined : changed(op)}>{w.text}</span> : null,
      )}
    </>
  );
}

const SIGN: Record<DiffOp['op'], string> = { same: '', del: '−', add: '+' };

export interface TextDiffProps {
  /** Which field this is, eg "body" or "title". */
  label: string;
  before: readonly string[];
  after: readonly string[];
}

/** Line diff of one text field in running text: within an edited line, removed words struck, added words in the accent; long unchanged runs folded. */
export function TextDiff({ label, before, after }: TextDiffProps) {
  const ops = diffLines(before, after);
  const anyChange = ops.some((o) => o.op !== 'same');
  let body: ReactNode;
  if (!anyChange) body = <p className="meta" style={{ margin: 0 }}>no text change</p>;
  else {
    const rows = fold(ops);
    const other = pairs(rows);
    body = rows.map((r, i) => {
      if (r.kind === 'fold') {
        return (
          <div key={i} data-testid="diff-fold" className="meta">
            {r.count} unchanged lines
          </div>
        );
      }
      const counterpart = other.get(i);
      const otherText = counterpart !== undefined ? (rows[counterpart] as { text: string }).text : undefined;
      return (
        <div key={i} data-testid="diff-line" data-op={r.op} data-text={r.text} style={{ display: 'flex', gap: 10, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: r.op === 'same' ? 'var(--grey)' : 'var(--ink)' }}>
          <span aria-hidden style={{ flex: '0 0 10px', color: 'var(--grey)' }}>{SIGN[r.op]}</span>
          <span>{r.op === 'same' ? r.text || ' ' : <Words op={r.op} text={r.text} other={otherText} />}</span>
        </div>
      );
    });
  }
  return (
    <section data-testid="text-diff" data-field={label} aria-label={`${label} changes`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <header className="meta" style={{ fontWeight: 500 }}>{label}</header>
      <div style={{ fontSize: 13, lineHeight: 1.55, display: 'flex', flexDirection: 'column', gap: 2 }}>{body}</div>
    </section>
  );
}
