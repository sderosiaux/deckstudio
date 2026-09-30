import type { MouseEvent } from 'react';
import type { Version, VersionCause } from '../../../src/model/types.js';
import { HISTORY_PATH, navigate as defaultNavigate } from '../api.js';

/** The two versions compared on the history screen: `a` is the reference, `b` the one diffed against it. */
export interface VersionPair {
  a: number;
  b: number;
}

export interface VersionLineProps {
  versions: Version[];
  current: number;
  /** When set, versions are selectable: click picks `a`, shift-click picks `b`. Without it, the line links to the history screen. */
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

const ring = '0 0 0 2px var(--paper), 0 0 0 4px var(--accent)';

/** The versions of main on one line, oldest to newest, the current one marked. */
export function VersionLine({ versions, current, selection, onSelect, navigate = defaultNavigate }: VersionLineProps) {
  const sorted = [...versions].sort((a, b) => a.n - b.n);
  const selectable = onSelect !== undefined;
  const openHistory = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(HISTORY_PATH);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: 12 }}>
      <div style={{ width: 120, flex: '0 0 120px', fontWeight: 700, fontSize: 13 }}>versions</div>
      {sorted.length === 0 ? (
        <span className="muted">No versions yet. Importing a deck creates v0.</span>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: '6px 4px', display: 'flex', gap: 8, overflowX: 'auto', minWidth: 0, flex: 1 }}>
          {sorted.map((v) => {
            const isCurrent = v.n === current;
            const cause = (v as Version & { label?: string }).label ?? describeCause(v.cause);
            const picked: keyof VersionPair | undefined = selection?.a === v.n ? 'a' : selection?.b === v.n ? 'b' : undefined;
            const marked = picked !== undefined || (!selectable && isCurrent);
            const content = (
              <>
                <span className="mono" style={{ fontWeight: 700, color: marked ? 'var(--accent)' : 'var(--ink)' }}>v{v.n}</span>
                <span className="muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {cause}
                  {selectable && isCurrent ? ' · now' : ''}
                </span>
              </>
            );
            const pill = {
              display: 'flex',
              gap: 6,
              alignItems: 'baseline',
              padding: '4px 10px',
              borderRadius: 999,
              border: `1px solid ${marked ? 'var(--accent)' : 'var(--line)'}`,
              background: 'var(--card)',
              fontSize: 12,
              maxWidth: 260,
              boxShadow: picked ? ring : 'none',
              transition: 'box-shadow .15s ease, border-color .15s ease',
            } as const;
            return (
              <li
                key={v.n}
                data-testid="version"
                data-version={v.n}
                data-selected={picked}
                aria-current={isCurrent ? 'true' : undefined}
                title={`v${v.n} · ${cause} · ${new Date(v.createdAt).toLocaleString()}`}
                style={{ flex: '0 0 auto', display: 'flex' }}
              >
                {selectable ? (
                  <button
                    type="button"
                    aria-pressed={picked !== undefined}
                    aria-label={`v${v.n}: click to compare from, shift-click to compare to`}
                    onClick={(e) => onSelect(v.n, e.shiftKey ? 'b' : 'a')}
                    style={{ ...pill, cursor: 'pointer', font: 'inherit', fontSize: 12, color: 'inherit' }}
                  >
                    {content}
                  </button>
                ) : (
                  <span style={pill}>{content}</span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {!selectable && sorted.length > 1 ? (
        <a href={HISTORY_PATH} onClick={openHistory} data-testid="history-link" style={{ flex: '0 0 auto', fontSize: 12, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}>
          compare versions →
        </a>
      ) : null}
    </div>
  );
}
