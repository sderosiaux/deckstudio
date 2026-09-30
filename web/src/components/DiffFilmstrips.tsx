import { useRef, type CSSProperties } from 'react';
import type { DiffEntry, SlideId, Snapshot } from '../../../src/model/types.js';
import { EdgeFade, useVisibleColumns } from './EdgeFade.js';
import { Thumb } from './Thumb.js';

/**
 * Pixel geometry of one column; set as CSS variables on the root so the Thumbs and the connectors agree.
 * About 1.25x main's thumbs so the compare fills the band; the columns past the edge scroll on behind a fade.
 */
const THUMB_W = 120;
const THUMB_H = 132;
const GAP = 12;
const COL = THUMB_W + GAP;
/** Height of the link band: with the numbers under v<a>, about 100px between the two rows. */
const CONNECTOR_H = 72;
const PAD = 6;
/** The row-name gutter, as on main. */
const GUTTER = 120;

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

const centerX = (col: number): number => GUTTER + PAD + col * COL + THUMB_W / 2;

const row: CSSProperties = { display: 'flex', gap: GAP, padding: `0 ${PAD}px` };
const cellStyle: CSSProperties = { position: 'relative', flex: `0 0 ${THUMB_W}px` };
/** Accent means "changed" here; the selected thumbnail uses the ink ring (Thumb ring="ink"), never the accent. */
const outline: CSSProperties = { position: 'absolute', left: 0, top: 0, width: THUMB_W, height: THUMB_H, borderRadius: 4, boxShadow: '0 0 0 1.5px var(--accent)', pointerEvents: 'none' };
const dot: CSSProperties = { position: 'absolute', top: 5, right: 5, width: 7, height: 7, borderRadius: 999, background: 'var(--accent)', pointerEvents: 'none' };
const slot: CSSProperties = {
  width: THUMB_W,
  height: THUMB_H,
  borderRadius: 6,
  border: '1px dashed var(--grey-2)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--grey)',
  fontSize: 12,
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
  const scroller = useRef<HTMLDivElement>(null);
  const visible = useVisibleColumns(scroller, '[data-testid="row-b"] > [role="listitem"]', [a.n, b.n, entries.length]);
  const cells = bRowCells(b.snapshot.order, entries);
  const aCells = aRowCells(a.snapshot.order, entries);
  const colInB = new Map(cells.flatMap((c, i) => (c.kind === 'slide' ? [[c.id, i] as const] : [])));
  const colInA = new Map(aCells.flatMap((c, i) => (c.kind === 'slide' ? [[c.id, i] as const] : [])));
  const added = new Set(entries.flatMap((e) => (e.kind === 'added' ? [e.slide] : [])));
  const modified = new Set(entries.flatMap((e) => (e.kind === 'modified' ? [e.slide] : [])));
  const moved = entries.flatMap((e) => (e.kind === 'moved' ? [e] : []));
  const width = GUTTER + PAD * 2 + Math.max(aCells.length, cells.length) * COL;
  const changedIds = new Set(entries.map((e) => e.slide));
  // Every slide in both versions, joined across the two rows; the moved ones are the diff markers, drawn on top.
  const matched = [...colInA].flatMap(([id, from]) => {
    const to = colInB.get(id);
    return to === undefined || moved.some((m) => m.slide === id) ? [] : [{ id, from, to }];
  });
  // A moved slide curves from its old column to its new one; a slide that kept its place is a straight hairline.
  const curve = (from: number, to: number): string => {
    const x1 = centerX(from);
    const x2 = centerX(to);
    return `M ${x1} 0 C ${x1} ${CONNECTOR_H / 2}, ${x2} ${CONNECTOR_H / 2}, ${x2} ${CONNECTOR_H}`;
  };
  const straight = (from: number, to: number): string => `M ${centerX(from)} 0 L ${centerX(to)} ${CONNECTOR_H}`;
  const label = (n: number) => (
    <div className="gutter row-label" style={{ fontWeight: 700, display: 'flex', alignItems: 'center' }}>
      v{n}
    </div>
  );
  const title = (side: DiffSide, id: SlideId): string => side.snapshot.slides[id]?.title ?? id;

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div ref={scroller} data-testid="diff-filmstrips" style={{ '--thumb-w': `${THUMB_W}px`, '--thumb-h': `${THUMB_H}px`, flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 32px 12px 0', display: 'flex', flexDirection: 'column' } as CSSProperties}>
        {/* The pair sits at the top of the band, a fixed link band between the rows. */}
        <div style={{ width, minWidth: '100%', flex: '0 0 auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'stretch' }}>
            {label(a.n)}
            <div role="list" aria-label={`slides in v${a.n}`} data-testid="row-a" data-edge-row style={row}>
              {aCells.map((c) =>
                c.kind === 'ghost' ? (
                  <div role="listitem" key={`ghost:${c.id}`} data-edge-item style={cellStyle}>
                    <div data-testid={`ghost-${c.id}`} className="edge-frame" title={`"${title(b, c.id)}" is slide ${c.at + 1} in v${b.n}`} style={{ ...slot, borderColor: c.id === focused ? 'var(--ink)' : 'var(--line)' }} />
                    <div className="meta" style={{ paddingTop: 4, textAlign: 'center' }}>not in v{a.n}</div>
                  </div>
                ) : (
                  <div role="listitem" key={c.id} data-edge-item style={cellStyle}>
                    <Thumb slideId={c.id} n={c.n} title={title(a, c.id)} url={a.thumbs[c.id]} selected={c.id === focused} ring="ink" onClick={() => onFocus(c.id)} />
                  </div>
                ),
              )}
            </div>
          </div>
          {/* The band has the rows' sticky gutter too, so scrolled links pass under the row names like the slides do. */}
          <div style={{ display: 'flex', flex: '0 0 auto', height: CONNECTOR_H, margin: '4px 0' }}>
          <div className="gutter" />
          <svg
            width={width - GUTTER}
            height={CONNECTOR_H}
            viewBox={`${GUTTER} 0 ${width - GUTTER} ${CONNECTOR_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            style={{ display: 'block', height: 'auto', alignSelf: 'stretch', flex: '0 0 auto' }}
          >
            {matched.map((m) => (
              <path
                key={`same:${m.id}`}
                data-testid="diff-link"
                data-slide={m.id}
                d={straight(m.from, m.to)}
                fill="none"
                vectorEffect="non-scaling-stroke"
                stroke={m.id === focused ? 'var(--ink)' : changedIds.has(m.id) ? 'var(--accent)' : 'var(--line)'}
                strokeWidth={m.id === focused ? 1.5 : 1}
              />
            ))}
            {moved.map((m) => {
              const to = colInB.get(m.slide);
              const from = colInA.get(m.slide);
              if (to === undefined || from === undefined) return null;
              return (
                <path
                  key={m.slide}
                  data-testid="diff-marker"
                  data-kind="moved"
                  data-slide={m.slide}
                  d={curve(from, to)}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                  stroke={m.slide === focused ? 'var(--ink)' : 'var(--accent)'}
                  strokeWidth={m.slide === focused ? 1.5 : 1}
                />
              );
            })}
          </svg>
          </div>
          <div style={{ display: 'flex', alignItems: 'stretch' }}>
            {label(b.n)}
            <div role="list" aria-label={`slides in v${b.n}`} data-testid="row-b" data-edge-row style={row}>
              {cells.map((c) =>
                c.kind === 'gone' ? (
                  <div role="listitem" key={`gone:${c.id}`} data-edge-item style={cellStyle}>
                    <div data-testid="diff-marker" data-kind="removed" data-slide={c.id} className="edge-frame" title={`"${title(a, c.id)}" was slide ${c.wasAt + 1} in v${a.n}`} style={{ ...slot, borderColor: c.id === focused ? 'var(--ink)' : 'var(--accent)' }}>
                      {title(a, c.id)}
                    </div>
                    <div className="meta" style={{ paddingTop: 4, textAlign: 'center' }}>removed</div>
                  </div>
                ) : (
                  <div role="listitem" key={c.id} data-edge-item style={cellStyle}>
                    <Thumb slideId={c.id} n={c.n} title={title(b, c.id)} url={b.thumbs[c.id]} selected={c.id === focused} ring="ink" onClick={() => onFocus(c.id)} />
                    {added.has(c.id) ? <div data-testid="diff-marker" data-kind="added" data-slide={c.id} className="diff-changed" style={outline} /> : null}
                    {modified.has(c.id) ? <div data-testid="diff-marker" data-kind="modified" data-slide={c.id} className="diff-changed" title="modified" style={dot} /> : null}
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      </div>
      <EdgeFade visible={visible} />
    </div>
  );
}
