import type { Version, VersionCause } from '../../../src/model/types.js';

export interface VersionLineProps {
  versions: Version[];
  current: number;
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

/** The versions of main on one line, oldest to newest, the current one marked. */
export function VersionLine({ versions, current }: VersionLineProps) {
  const sorted = [...versions].sort((a, b) => a.n - b.n);
  return (
    <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
      <div style={{ width: 120, flex: '0 0 120px', fontWeight: 700, fontSize: 13 }}>versions</div>
      {sorted.length === 0 ? (
        <span className="muted">No versions yet. Importing a deck creates v0.</span>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: '4px 0', display: 'flex', gap: 8, overflowX: 'auto', minWidth: 0 }}>
          {sorted.map((v) => {
            const isCurrent = v.n === current;
            const cause = (v as Version & { label?: string }).label ?? describeCause(v.cause);
            return (
              <li
                key={v.n}
                data-testid="version"
                aria-current={isCurrent ? 'true' : undefined}
                title={`v${v.n} · ${cause} · ${new Date(v.createdAt).toLocaleString()}`}
                style={{
                  flex: '0 0 auto',
                  display: 'flex',
                  gap: 6,
                  alignItems: 'baseline',
                  padding: '4px 10px',
                  borderRadius: 999,
                  border: `1px solid ${isCurrent ? 'var(--accent)' : 'var(--line)'}`,
                  background: 'var(--card)',
                  fontSize: 12,
                  maxWidth: 260,
                }}
              >
                <span className="mono" style={{ fontWeight: 700, color: isCurrent ? 'var(--accent)' : 'var(--ink)' }}>v{v.n}</span>
                <span className="muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cause}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
