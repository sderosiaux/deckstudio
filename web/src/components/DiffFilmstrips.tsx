import type { CSSProperties } from 'react';
import type { DiffEntry, SlideId, Snapshot } from '../../../src/model/types.js';
import { Thumb } from './Thumb.js';

/** Pixel geometry of one column; set as CSS variables on the root so the Thumbs and the connectors agree. */
const THUMB_W = 160;
const THUMB_H = 90;
const GAP = 16;
const COL = THUMB_W + GAP;
const CONNECTOR_H = 48;
const PAD = 8;

export interface DiffSide {
  n: number;
  snapshot: Snapshot;
  /** Thumbnail URL per slide of this side; undefined shows the title card. */
  thumbs: Record<SlideId, string | undefined>;
}

export interface DiffFilmstripsProps {
  a: DiffSide;
  b: DiffSide;
  entries: DiffEntry[];
  focused?: SlideId;
  onFocus(id: SlideId): void;
}

type Cell = { kind: 'slide'; id: SlideId; n: number } | { kind: 'gone'; id: SlideId; wasAt: number };
type ACell = { kind: 'slide'; id: SlideId; n: number } | { kind: 'ghost'; id: SlideId; at: number };

/** Row b: b's slides in order, with a dashed slot at the old position of every slide only in a. */
export function bRowCells(bOrder: SlideId[], entries: DiffEntry[]): Cell[] {
  const cells: Cell[] = bOrder.map((id, i) => ({ kind: 'slide', id, n: i + 1 }));
  const removed = entries.flatMap((e) => (e.kind === 'removed' ? [e] : [])).sort((x, y) => x.wasAt - y.wasAt);
  for (const r of removed) cells.splice(Math.min(r.wasAt, cells.length), 0, { kind: 'gone', id: r.slide, wasAt: r.wasAt });
  return cells;
}

/** Row a: a's slides in order, with a dashed slot at the new position of every slide only in b, so both rows stay aligned. */
export function aRowCells(aOrder: SlideId[], entries: DiffEntry[]): ACell[] {
  const cells: ACell[] = aOrder.map((id, i) => ({ kind: 'slide', id, n: i + 1 }));
  const added = entries.flatMap((e) => (e.kind === 'added' ? [e] : [])).sort((x, y) => x.at - y.at);
  for (const e of added) cells.splice(Math.min(e.at, cells.length), 0, { kind: 'ghost', id: e.slide, at: e.at });
  return cells;
}

const centerX = (col: number): number => PAD + col * COL + THUMB_W / 2;

const rowLabel: CSSProperties = { position: 'sticky', left: 0, fontWeight: 700, fontSize: 18, padding: `0 ${PAD}px 8px`, width: 'max-content' };
const row: CSSProperties = { display: 'flex', gap: GAP, padding: `0 ${PAD}px` };
const cellStyle: CSSProperties = { position: 'relative', flex: `0 0 ${THUMB_W}px` };
/** Accent means "changed" here; the selected thumbnail uses the ink ring (Thumb ring="ink"), never the accent. */
const outline: CSSProperties = { position: 'absolute', left: -3, top: -3, width: THUMB_W + 6, height: THUMB_H + 6, borderRadius: 8, border: '2px solid var(--accent)', pointerEvents: 'none' };
const dot: CSSProperties = { position: 'absolute', top: 6, right: 6, width: 10, height: 10, borderRadius: 999, background: 'var(--accent)', boxShadow: '0 0 0 2px var(--card)', pointerEvents: 'none' };
const slot: CSSProperties = {
  width: THUMB_W,
  height: THUMB_H,
  borderRadius: 6,
  border: '1.5px dashed var(--grey-2)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--grey)',
  fontSize: 11,
  textAlign: 'center',
  padding: 8,
  overflow: 'hidden',
};

/**
 * Two column-aligned filmstrips, v<a> above v<b>, sharing one horizontal scroll. Every diff entry gets exactly one
 * `diff-marker`: added = accent outline in b (plus an unmarked dashed slot in a), removed = dashed slot in b at its
 * old position, modified = accent dot in b, moved = a connector from its column in a to its column in b.
 */
export function DiffFilmstrips({ a, b, entries, focused, onFocus }: DiffFilmstripsProps) {
  const cells = bRowCells(b.snapshot.order, entries);
  const aCells = aRowCells(a.snapshot.order, entries);
  const colInB = new Map(cells.flatMap((c, i) => (c.kind === 'slide' ? [[c.id, i] as const] : [])));
  const colInA = new Map(aCells.flatMap((c, i) => (c.kind === 'slide' ? [[c.id, i] as const] : [])));
  const added = new Set(entries.flatMap((e) => (e.kind === 'added' ? [e.slide] : [])));
  const modified = new Set(entries.flatMap((e) => (e.kind === 'modified' ? [e.slide] : [])));
  const moved = entries.flatMap((e) => (e.kind === 'moved' ? [e] : []));
  const width = PAD * 2 + Math.max(aCells.length, cells.length) * COL;
  const title = (side: DiffSide, id: SlideId): string => side.snapshot.slides[id]?.title ?? id;

  return (
    <div
      data-testid="diff-filmstrips"
      style={{ '--thumb-w': `${THUMB_W}px`, '--thumb-h': `${THUMB_H}px`, overflowX: 'auto', padding: '4px 0 12px' } as CSSProperties}
    >
      <div style={{ width, minWidth: '100%' }}>
        <div style={rowLabel} className="mono">v{a.n}</div>
        <div role="list" aria-label={`slides in v${a.n}`} data-testid="row-a" style={row}>
          {aCells.map((c) =>
            c.kind === 'ghost' ? (
              <div role="listitem" key={`ghost:${c.id}`} style={cellStyle}>
                <div data-testid={`ghost-${c.id}`} title={`"${title(b, c.id)}" is slide ${c.at + 1} in v${b.n}`} style={{ ...slot, borderColor: c.id === focused ? 'var(--ink)' : 'var(--grey-2)' }} />
                <div className="muted" style={{ fontSize: 12, paddingTop: 6 }}>not in v{a.n}</div>
              </div>
            ) : (
              <div role="listitem" key={c.id} style={cellStyle}>
                <Thumb slideId={c.id} n={c.n} title={title(a, c.id)} url={a.thumbs[c.id]} selected={c.id === focused} ring="ink" onClick={() => onFocus(c.id)} />
              </div>
            ),
          )}
        </div>
        <svg width={width} height={CONNECTOR_H} aria-hidden="true" style={{ display: 'block' }}>
          {moved.map((m) => {
            const to = colInB.get(m.slide);
            if (to === undefined) return null;
            const from = colInA.get(m.slide);
            if (from === undefined) return null;
            const x1 = centerX(from);
            const x2 = centerX(to);
            return (
              <path
                key={m.slide}
                data-testid="diff-marker"
                data-kind="moved"
                data-slide={m.slide}
                d={`M ${x1} 2 C ${x1} ${CONNECTOR_H / 2}, ${x2} ${CONNECTOR_H / 2}, ${x2} ${CONNECTOR_H - 2}`}
                fill="none"
                stroke={m.slide === focused ? 'var(--ink)' : 'var(--grey-2)'}
                strokeWidth={m.slide === focused ? 2 : 1.25}
              />
            );
          })}
        </svg>
        <div style={rowLabel} className="mono">v{b.n}</div>
        <div role="list" aria-label={`slides in v${b.n}`} data-testid="row-b" style={row}>
          {cells.map((c) =>
            c.kind === 'gone' ? (
              <div role="listitem" key={`gone:${c.id}`} style={cellStyle}>
                <div data-testid="diff-marker" data-kind="removed" data-slide={c.id} title={`"${title(a, c.id)}" was slide ${c.wasAt + 1} in v${a.n}`} style={{ ...slot, borderColor: c.id === focused ? 'var(--ink)' : 'var(--grey-2)' }}>
                  {title(a, c.id)}
                </div>
                <div className="muted" style={{ fontSize: 12, paddingTop: 6 }}>removed</div>
              </div>
            ) : (
              <div role="listitem" key={c.id} style={cellStyle}>
                <Thumb slideId={c.id} n={c.n} title={title(b, c.id)} url={b.thumbs[c.id]} selected={c.id === focused} ring="ink" onClick={() => onFocus(c.id)} />
                {added.has(c.id) ? <div data-testid="diff-marker" data-kind="added" data-slide={c.id} className="diff-changed" style={outline} /> : null}
                {modified.has(c.id) ? <div data-testid="diff-marker" data-kind="modified" data-slide={c.id} className="diff-changed" title="modified" style={dot} /> : null}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
