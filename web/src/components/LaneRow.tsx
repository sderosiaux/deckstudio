import { useState, type CSSProperties } from 'react';
import type { Anchor, Change, Lane, SlideId } from '../../../src/model/types.js';
import { thumbUrl, type LaneApi, type LanePreviewPayload } from '../api.js';
import { ChangeButtons } from './ChangeButtons.js';
import { Thumb } from './Thumb.js';

export interface LaneRowProps {
  lane: Lane;
  /** Undefined while loading. */
  preview: LanePreviewPayload | undefined;
  mainOrder: SlideId[];
  /** Thumbnails of main, reused for the lane's unchanged slides. */
  mainThumbs: Record<SlideId, string | undefined>;
  api: LaneApi;
}

/** Deck columns an anchor covers on main: 0-based start and width. Null when an anchor slide is no longer on main. */
export function anchorColumns(anchor: Anchor, order: SlideId[]): { start: number; span: number } | null {
  if (anchor.kind === 'arc') return { start: 0, span: Math.max(order.length, 1) };
  if (anchor.kind === 'slide') {
    const i = order.indexOf(anchor.slide);
    return i < 0 ? null : { start: i, span: 1 };
  }
  const a = order.indexOf(anchor.from);
  const b = order.indexOf(anchor.to);
  if (a < 0 || b < 0) return null;
  return { start: Math.min(a, b), span: Math.abs(b - a) + 1 };
}

type Mark = 'none' | 'inserted' | 'modified' | 'moved' | 'removed';
interface Cell {
  id: SlideId;
  title: string;
  mark: Mark;
  changes: Change[];
}

const targetOf = (c: Change): SlideId => (c.kind === 'insert' ? c.slide.id : c.slide);

/**
 * The lane's preview slides that belong in the row: those of the anchor range, plus any slide the
 * lane inserts or moves (even from outside the range), in preview order. Removed slides become
 * empty slots right after the slide that preceded them on main.
 */
export function laneCells(lane: Lane, preview: LanePreviewPayload, mainOrder: SlideId[], cols: { start: number; span: number }): Cell[] {
  const skipped = new Set(preview.skipped);
  const live = lane.changes.filter((c) => c.status === 'pending' && !skipped.has(c.id));
  const byTarget = new Map<SlideId, Change[]>();
  for (const c of live) byTarget.set(targetOf(c), [...(byTarget.get(targetOf(c)) ?? []), c]);
  const has = (id: SlideId, kind: Change['kind']): boolean => (byTarget.get(id) ?? []).some((c) => c.kind === kind);

  const range = new Set(mainOrder.slice(cols.start, cols.start + cols.span));
  const markOf = (id: SlideId): Mark => (has(id, 'insert') ? 'inserted' : has(id, 'move') ? 'moved' : has(id, 'modify') ? 'modified' : 'none');
  const cells: Cell[] = preview.order
    .filter((id) => range.has(id) || has(id, 'insert') || has(id, 'move'))
    .map((id) => ({ id, title: preview.slides[id]?.title ?? id, mark: markOf(id), changes: byTarget.get(id) ?? [] }));

  const inPreview = new Set(preview.order);
  for (const id of mainOrder) {
    if (inPreview.has(id) || !has(id, 'remove')) continue;
    const slot: Cell = { id, title: preview.slides[id]?.title ?? id, mark: 'removed', changes: byTarget.get(id) ?? [] };
    let at = 0;
    for (let i = mainOrder.indexOf(id) - 1; i >= 0; i--) {
      const prev = cells.findIndex((c) => c.id === mainOrder[i]);
      if (prev >= 0) {
        at = prev + 1;
        break;
      }
    }
    cells.splice(at, 0, slot);
  }
  return cells;
}

/** Width of `n` deck columns, matching the filmstrip's thumb width + gap. */
const columns = (n: number): string => `calc(${n} * (var(--thumb-w) + var(--col-gap)))`;

const overlay: CSSProperties = { position: 'absolute', top: 0, left: 0, width: 'var(--thumb-w)', height: 'var(--thumb-h)', pointerEvents: 'none', borderRadius: 6 };

function originTag(origin: Lane['origin']): string | null {
  return origin.startsWith('check:') ? `unsolicited · from check: ${origin.slice('check:'.length)}` : null;
}

/**
 * One open lane, laid out under main: the row uses the same column grid as the filmstrip and the lane
 * occupies only its anchor's columns, so each proposed slide sits under the slide it replaces.
 */
export function LaneRow({ lane, preview, mainOrder, mainThumbs, api }: LaneRowProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const accept = (cid: string) => void run(() => api.acceptChange(lane.id, cid));
  const refuse = (cid: string) => void run(() => api.refuseChange(lane.id, cid));

  const anchored = anchorColumns(lane.anchor, mainOrder);
  const cols = anchored ?? { start: 0, span: Math.max(mainOrder.length, 1) };
  const cells = preview ? laneCells(lane, preview, mainOrder, cols) : [];
  const skipped = preview ? lane.changes.filter((c) => c.status === 'pending' && preview.skipped.includes(c.id)) : [];
  const tag = originTag(lane.origin);

  const urlFor = (id: SlideId): string | undefined => {
    const t = preview?.thumbs[id];
    if (t) return t.ready ? thumbUrl(t.hash) : undefined;
    return mainThumbs[id];
  };

  return (
    <div data-testid="lane-row" data-lane={lane.id} style={{ display: 'flex', alignItems: 'flex-start' }}>
      <div style={{ width: 120, flex: '0 0 120px' }} />
      <div
        data-testid="lane-grid"
        style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(mainOrder.length, 1)}, var(--thumb-w))`, columnGap: 'var(--col-gap)', padding: '0 6px' }}
      >
        <section
          data-testid="lane-region"
          data-col-start={cols.start}
          data-col-span={cols.span}
          aria-label={`lane ${lane.label}`}
          style={{ gridColumn: `${cols.start + 1} / span ${cols.span}`, minWidth: 0 }}
        >
          <div aria-hidden style={{ height: 8, border: '1px solid var(--grey-2)', borderBottom: 'none', borderRadius: '4px 4px 0 0', marginBottom: 8 }} />
          <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, whiteSpace: 'nowrap' }}>
            <strong style={{ fontSize: 14 }}>{lane.label}</strong>
            {tag ? <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'var(--line)', color: 'var(--grey)' }}>{tag}</span> : null}
            {anchored ? null : <span className="muted" style={{ fontSize: 11 }}>anchor no longer on main</span>}
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => api.discardLane(lane.id))}
              style={{ all: 'unset', cursor: busy ? 'default' : 'pointer', fontSize: 12, color: 'var(--grey)', textDecoration: 'underline', textUnderlineOffset: 3 }}
            >
              discard lane
            </button>
          </header>
          {error ? (
            <p role="alert" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--warn)', whiteSpace: 'normal' }}>
              {error}
            </p>
          ) : null}
          {!preview ? (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Loading lane preview…</p>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--col-gap)' }}>
              {cells.map((cell, i) => (
                <div key={`${cell.mark}:${cell.id}`} data-testid="lane-cell" data-slide={cell.id} data-mark={cell.mark} style={{ position: 'relative', flex: '0 0 var(--thumb-w)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {cell.mark === 'removed' ? (
                    <div data-testid="removed-slot" title={`removed: ${cell.title}`} style={{ width: 'var(--thumb-w)', height: 'var(--thumb-h)', borderRadius: 6, border: '1.5px dashed var(--grey-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--grey)', fontSize: 11, padding: 8, textAlign: 'center' }}>
                      removed · {cell.title}
                    </div>
                  ) : (
                    <>
                      <Thumb slideId={cell.id} n={cols.start + i + 1} title={cell.title} url={urlFor(cell.id)} selected={false} onClick={() => undefined} />
                      {cell.mark === 'inserted' ? (
                        <>
                          <div style={{ ...overlay, boxShadow: '0 0 0 2px var(--accent)' }} />
                          <div data-testid="insert-badge" style={{ ...overlay, width: 20, height: 20, top: 4, left: 'calc(var(--thumb-w) - 24px)', borderRadius: 999, background: 'var(--accent)', color: 'var(--card)', fontWeight: 700, fontSize: 14, lineHeight: '20px', textAlign: 'center' }}>+</div>
                        </>
                      ) : null}
                      {cell.mark === 'modified' ? <div data-testid="modified-dot" style={{ ...overlay, width: 8, height: 8, top: 6, left: 'calc(var(--thumb-w) - 14px)', borderRadius: 999, background: 'var(--accent)' }} /> : null}
                      {cell.mark === 'moved' ? <MoveConnector delta={mainOrder.indexOf(cell.id) - (cols.start + i)} /> : null}
                    </>
                  )}
                  {cell.changes.map((c) => (
                    <ChangeButtons key={c.id} change={c} disabled={busy} onAccept={accept} onRefuse={refuse} />
                  ))}
                </div>
              ))}
            </div>
          )}
          {skipped.length > 0 ? (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {skipped.map((c) => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span className="muted">{c.kind} {targetOf(c)} no longer applies on main</span>
                  <ChangeButtons change={c} disabled={busy} onAccept={accept} onRefuse={refuse} />
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/** Thin line along the top of a moved slide to the column it occupies on main (`delta` columns away, signed), ticking up there. */
function MoveConnector({ delta }: { delta: number }) {
  if (delta === 0) return <span data-testid="move-connector" data-delta="0" hidden />;
  const side: CSSProperties = delta > 0 ? { left: 'calc(var(--thumb-w) / 2)' } : { right: 'calc(var(--thumb-w) / 2)' };
  return (
    <div
      data-testid="move-connector"
      data-delta={delta}
      aria-hidden
      style={{
        position: 'absolute',
        top: -10,
        height: 10,
        width: columns(Math.abs(delta)),
        ...side,
        borderBottom: '1px solid var(--accent)',
        borderRight: delta > 0 ? '1px solid var(--accent)' : undefined,
        borderLeft: delta < 0 ? '1px solid var(--accent)' : undefined,
        pointerEvents: 'none',
      }}
    />
  );
}
