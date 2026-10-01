import { useLayoutEffect, useRef, type CSSProperties, type MouseEvent } from 'react';
import type { Version, VersionCause } from '../../../src/model/types.js';
import { historyPath, navigate as defaultNavigate } from '../api.js';

/** The two versions compared on the history screen: `a` is the reference, `b` the one diffed against it. */
export interface VersionPair {
  a: number;
  b: number;
}

export interface VersionLineProps {
  versions: Version[];
  current: number;
  /**
   * When set, versions are selectable: click picks `a`, shift-click picks `b`. Without it, every version links to the
   * history screen comparing it with the current one (the current one opens the default comparison).
   */
  selection?: VersionPair;
  onSelect?(n: number, which: keyof VersionPair): void;
  navigate?(path: string): void;
}

function describeCause(c: VersionCause): string {
  switch (c.kind) {
    case 'import':
      return 'import';
    case 'accept':
      return c.laneId === 'manual' ? 'manual edit' : `accept ${c.changeId} (${c.laneId})`;
    case 'restore':
      return `restore from v${c.from}`;
  }
}

/** Short content fingerprint of a version (FNV-1a over its order and slide hashes), shown like a commit id. */
export function versionHash(v: Pick<Version, 'order' | 'slides'>): string {
  const text = v.order.map((id) => `${id}:${v.slides[id] ?? ''}`).join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 7);
}

const NODE = 11;
const node = (marked: boolean, current: boolean): CSSProperties => ({
  width: NODE,
  height: NODE,
  borderRadius: 999,
  boxSizing: 'border-box',
  border: `1px solid ${marked ? 'var(--accent)' : 'var(--grey-2)'}`,
  background: marked ? 'radial-gradient(circle, var(--accent) 0 3px, var(--paper) 3.5px)' : current ? 'var(--ink)' : 'var(--paper)',
  transition: 'border-color .15s ease, background .15s ease',
});

/** What the rail says of a version without slides (v0, before the import). */
export const EMPTY_VERSION = 'empty';

/** The rail keeps a label's first clause ('added "X"' of 'added "X" · Hook: …'); the tooltip has the whole of it. */
export const railCause = (cause: string): string => cause.split(' · ')[0]!.trim();

/** What made the version, wrapped on up to two 12px lines (a 144px history column holds about 40 characters): a quoted slide title reads whole rather than cut mid-word. */
const causeStyle: CSSProperties = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  lineHeight: '16px',
  maxHeight: 32,
  overflowWrap: 'anywhere',
};

/** Versions the rail on main shows at most; older ones fold into one "… N earlier" link to the history. */
export const RAIL_MAX = 6;

/** The versions of main as a thin rail, oldest to newest: a node per version, its name and fingerprint under it. */
export function VersionLine({ versions, current, selection, onSelect, navigate = defaultNavigate }: VersionLineProps) {
  const all = [...versions].sort((a, b) => a.n - b.n);
  const selectable = onSelect !== undefined;
  // On main the rail keeps the newest versions (the current one always among them); the history screen, where any
  // version can be picked, shows them all.
  const kept = selectable || all.length <= RAIL_MAX ? all : all.slice(-RAIL_MAX);
  const sorted = kept.some((v) => v.n === current) ? kept : [...all.filter((v) => v.n === current), ...kept.slice(1)];
  const earlier = all.length - sorted.length;
  // The history rail is the screen's subject: columns wide enough for a restore's label on two lines. Main keeps six
  // narrow ones beside its lanes.
  const col = selectable ? 144 : 112;
  const rail = useRef<HTMLOListElement>(null);
  const pairLo = selection ? Math.min(selection.a, selection.b) : undefined;
  const pairHi = selection ? Math.max(selection.a, selection.b) : undefined;
  // In sight: the compared pair on the history (the earlier one, then the later one, so both show when they fit), the
  // current version on main; on mount, and whenever the pair or main moves.
  useLayoutEffect(() => {
    const el = rail.current;
    if (!el) return;
    const at = (n: number): Element | null => el.querySelector(`[data-version="${n}"]`);
    const targets = pairLo !== undefined && pairHi !== undefined ? [at(pairLo), pairHi !== pairLo ? at(pairHi) : null] : [el.querySelector('[aria-current="true"]')];
    for (const t of targets) t?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current, pairLo, pairHi]);
  const openHistory = (path: string) => (e: MouseEvent<HTMLAnchorElement>): void => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(path);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', minWidth: 0 }}>
      <div className="gutter row-label" style={{ position: 'static', paddingTop: 0, lineHeight: `${NODE}px` }}>versions</div>
      {sorted.length === 0 ? (
        <span className="muted">No versions yet. Importing a deck creates v0.</span>
      ) : (
        <>
        {earlier > 0 ? (
          <a href={historyPath()} onClick={openHistory(historyPath())} data-testid="versions-earlier" className="link" title="open the history" style={{ flex: '0 0 auto', fontSize: 12, lineHeight: `${NODE}px`, paddingLeft: 6, marginRight: 4, whiteSpace: 'nowrap' }}>
            … {earlier} earlier
          </a>
        ) : null}
        <ol ref={rail} style={{ position: 'relative', listStyle: 'none', margin: 0, padding: '0 6px', display: 'flex', overflowX: 'auto', scrollPaddingInline: 6, minWidth: 0, flex: 1 }}>
          {sorted.map((v, i) => {
            const isCurrent = v.n === current;
            // v0 is the empty deck a new or imported deck starts from: "imported" read as if it held the slides.
            const cause = v.order.length === 0 ? EMPTY_VERSION : ((v as Version & { label?: string }).label ?? describeCause(v.cause));
            // An accept's label ends with its lane's name, kept for the tooltip; any other label (a restore says which
            // slide went back to what) is shown whole.
            const railText = v.order.length > 0 && v.cause.kind === 'accept' ? railCause(cause) : cause;
            const picked: keyof VersionPair | undefined = selection?.a === v.n ? 'a' : selection?.b === v.n ? 'b' : undefined;
            const marked = picked !== undefined || (!selectable && isCurrent);
            const hash = versionHash(v);
            const content = (
              <>
                <span style={{ position: 'relative', display: 'block', height: NODE }}>
                  {/* the rail: a hairline from this node to the next one */}
                  {i < sorted.length - 1 ? <span aria-hidden style={{ position: 'absolute', left: NODE, top: Math.floor(NODE / 2), width: 'calc(100% - 11px + 16px)', borderTop: '1px solid var(--line)' }} /> : null}
                  <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, ...node(marked, isCurrent && selectable) }} />
                </span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginTop: 6, fontSize: 13, whiteSpace: 'nowrap' }}>
                  <span style={{ fontWeight: 700, color: marked ? 'var(--accent)' : 'var(--ink)' }}>v{v.n}</span>
                  {isCurrent ? <span className="meta">now</span> : null}
                  {picked ? <span data-testid="version-pick" style={{ fontSize: 12, fontWeight: 500, color: 'var(--accent)' }}>{picked === 'a' ? 'from' : 'to'}</span> : null}
                </span>
                <span className="meta" data-testid="version-cause" style={causeStyle}>{railText}</span>
                <span className="mono meta" data-testid="version-hash" style={{ display: 'block' }}>{hash}</span>
              </>
            );
            const box: CSSProperties = { all: 'unset', boxSizing: 'border-box', display: 'block', width: '100%', cursor: 'pointer', color: 'inherit' };
            return (
              <li
                key={v.n}
                data-testid="version"
                data-version={v.n}
                data-selected={picked}
                aria-current={isCurrent ? 'true' : undefined}
                title={`v${v.n}, ${cause}, ${new Date(v.createdAt).toLocaleString()}`}
                style={{ flex: `1 0 ${col}px`, minWidth: col, maxWidth: col + 32, paddingRight: 16 }}
              >
                {selectable ? (
                  <button type="button" aria-pressed={picked !== undefined} aria-label={`v${v.n}: click to compare from, shift-click to compare to`} onClick={(e) => onSelect(v.n, e.shiftKey ? 'b' : 'a')} style={box}>
                    {content}
                  </button>
                ) : (
                  <a
                    href={isCurrent ? historyPath() : historyPath(v.n, current)}
                    onClick={openHistory(isCurrent ? historyPath() : historyPath(v.n, current))}
                    aria-label={isCurrent ? `v${v.n}, current: open the history` : `compare v${v.n} with v${current}`}
                    style={{ ...box, textDecoration: 'none' }}
                  >
                    {content}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
        </>
      )}
      {!selectable && sorted.length > 1 ? (
        <a href={historyPath()} onClick={openHistory(historyPath())} data-testid="history-link" className="link" style={{ flex: '0 0 auto', fontSize: 12, lineHeight: `${NODE}px`, marginLeft: 12 }}>
          compare versions
        </a>
      ) : null}
    </div>
  );
}
