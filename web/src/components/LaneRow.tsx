import { useState, type CSSProperties } from 'react';
import type { Anchor, Change, Lane, Remark, SlideId } from '../../../src/model/types.js';
import { focusPath, navigate, remarkApi as defaultRemarkApi, thumbUrl, type LaneApi, type LanePreviewPayload, type RemarkApi } from '../api.js';
import { ChangeButtons } from './ChangeButtons.js';
import { RemarkPostIt } from './Remark.js';
import { Thumb } from './Thumb.js';

export interface LaneRowProps {
  lane: Lane;
  /** Undefined while loading. */
  preview: LanePreviewPayload | undefined;
  mainOrder: SlideId[];
  /** Thumbnails of main, reused for the lane's unchanged slides. */
  mainThumbs: Record<SlideId, string | undefined>;
  api: LaneApi;
  /** Opens the focus screen on a change; defaults to the client-side route. */
  onOpenChange?(laneId: string, changeId: string): void;
  /** Preview thumb hashes whose render failed: those cells show the failed card, clicking it retries. */
  failedThumbs?: ReadonlySet<string>;
  /** Re-requests the lane preview, which re-enqueues its thumbnails. */
  onRetryThumbs?(laneId: string): void;
  /** Open remarks raised by a check on this lane's content (`sourceLaneId === lane.id`), pinned under the cell they anchor to. */
  remarks?: readonly Remark[];
  remarkApi?: RemarkApi;
}

// Shown in the thumb slot when the server reports a failed render; clicking that thumb re-requests it.
export const FAILED_THUMB = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#F3E3DD"/>' +
    '<text x="80" y="50" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="600" fill="#B8432A">render failed · retry</text></svg>',
)}`;

const NO_FAILED: ReadonlySet<string> = new Set();
const NO_REMARKS: readonly Remark[] = [];

/** Lane slide a lane-scoped remark points at: the slide itself, or the first slide of a range in lane order. Null for arc. */
function remarkSlide(anchor: Anchor, laneOrder: readonly SlideId[]): SlideId | null {
  if (anchor.kind === 'arc') return null;
  if (anchor.kind === 'slide') return anchor.slide;
  const a = laneOrder.indexOf(anchor.from);
  const b = laneOrder.indexOf(anchor.to);
  return a >= 0 && b >= 0 && b < a ? anchor.to : anchor.from;
}

const openFocus = (laneId: string, changeId: string): void => navigate(focusPath(laneId, changeId));

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
export interface Cell {
  id: SlideId;
  title: string;
  mark: Mark;
  changes: Change[];
  /** 0-based main (deck) column the cell sits under. */
  col: number;
  /** 1-based row inside the lane: in-place slides take row 1, inserted/moved ones stack below in their column. */
  row: number;
}

const targetOf = (c: Change): SlideId => (c.kind === 'insert' ? c.slide.id : c.slide);

/**
 * The lane's slides that belong in the row, each pinned to a main column:
 * - slides of the anchor range and any slide with a live change (even outside the range);
 * - an unchanged, modified or removed slide sits under its own main column (removed ones as empty slots);
 * - an inserted or moved slide sits under the column of the main slide it goes after, stacked below that
 *   column's own slide (a slide inserted at the very start goes under column 0).
 * Cells come sorted by column, then row.
 */
export function laneCells(lane: Lane, preview: LanePreviewPayload, mainOrder: SlideId[], cols: { start: number; span: number }): Cell[] {
  const skipped = new Set(preview.skipped);
  const live = lane.changes.filter((c) => c.status === 'pending' && !skipped.has(c.id));
  const byTarget = new Map<SlideId, Change[]>();
  for (const c of live) byTarget.set(targetOf(c), [...(byTarget.get(targetOf(c)) ?? []), c]);
  const has = (id: SlideId, kind: Change['kind']): boolean => (byTarget.get(id) ?? []).some((c) => c.kind === kind);
  const mainIndex = new Map(mainOrder.map((id, i) => [id, i] as const));
  const displaced = (id: SlideId): boolean => has(id, 'insert') || has(id, 'move') || !mainIndex.has(id);

  const range = new Set(mainOrder.slice(cols.start, cols.start + cols.span));
  const markOf = (id: SlideId): Mark => (has(id, 'insert') ? 'inserted' : has(id, 'move') ? 'moved' : has(id, 'modify') ? 'modified' : 'none');

  // Column of a displaced slide: its change's `after` when that is on main, else the nearest preceding
  // in-place slide of the preview (e.g. after another inserted slide), else column 0.
  const displacedCol = (id: SlideId, pos: number): number => {
    const c = (byTarget.get(id) ?? []).find((x) => x.kind === 'insert' || x.kind === 'move');
    const after = c && (c.kind === 'insert' || c.kind === 'move') ? c.after : undefined;
    if (after === null) return 0;
    if (after !== undefined && mainIndex.has(after) && !displaced(after)) return mainIndex.get(after)!;
    for (let j = pos - 1; j >= 0; j--) {
      const prev = preview.order[j]!;
      if (!displaced(prev)) return mainIndex.get(prev)!;
    }
    return 0;
  };

  const placed: Array<Omit<Cell, 'row'> & { inPlace: boolean; seq: number }> = [];
  preview.order.forEach((id, pos) => {
    if (!range.has(id) && !byTarget.has(id)) return;
    const inPlace = !displaced(id);
    const col = inPlace ? mainIndex.get(id)! : displacedCol(id, pos);
    placed.push({ id, title: preview.slides[id]?.title ?? id, mark: markOf(id), changes: byTarget.get(id) ?? [], col, inPlace, seq: pos });
  });
  const inPreview = new Set(preview.order);
  for (const [i, id] of mainOrder.entries()) {
    if (inPreview.has(id) || !has(id, 'remove')) continue;
    placed.push({ id, title: preview.slides[id]?.title ?? id, mark: 'removed', changes: byTarget.get(id) ?? [], col: i, inPlace: true, seq: -1 });
  }

  const inPlaceCols = new Set(placed.filter((c) => c.inPlace).map((c) => c.col));
  const stacked = new Map<number, number>();
  const cells: Cell[] = placed
    .sort((a, b) => a.col - b.col || Number(b.inPlace) - Number(a.inPlace) || a.seq - b.seq)
    .map((p) => {
      const cell = { id: p.id, title: p.title, mark: p.mark, changes: p.changes, col: p.col };
      if (p.inPlace) return { ...cell, row: 1 };
      const k = stacked.get(p.col) ?? 0;
      stacked.set(p.col, k + 1);
      return { ...cell, row: (inPlaceCols.has(p.col) ? 2 : 1) + k };
    });
  return cells;
}

/** The columns the lane region covers: the anchor, widened to every cell's column. */
export function regionColumns(cols: { start: number; span: number }, cells: readonly Cell[]): { start: number; span: number } {
  const start = Math.min(cols.start, ...cells.map((c) => c.col));
  const end = Math.max(cols.start + cols.span - 1, ...cells.map((c) => c.col));
  return { start, span: end - start + 1 };
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
export function LaneRow({
  lane,
  preview,
  mainOrder,
  mainThumbs,
  api,
  onOpenChange = openFocus,
  failedThumbs = NO_FAILED,
  onRetryThumbs,
  remarks = NO_REMARKS,
  remarkApi = defaultRemarkApi,
}: LaneRowProps) {
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
  const region = regionColumns(cols, cells);
  const skipped = preview ? lane.changes.filter((c) => c.status === 'pending' && preview.skipped.includes(c.id)) : [];
  const tag = originTag(lane.origin);
  // Remarks pinned to a shown cell go under it; the rest (arc, or a slide not in the row) under the cells.
  const cellIds = new Set(cells.map((c) => c.id));
  const pinned = new Map<SlideId, Remark[]>();
  const loose: Remark[] = [];
  for (const r of remarks) {
    const id = remarkSlide(r.anchor, preview?.order ?? []);
    if (id !== null && cellIds.has(id)) pinned.set(id, [...(pinned.get(id) ?? []), r]);
    else loose.push(r);
  }
  const postIt = (r: Remark) => <RemarkPostIt key={r.id} remark={r} onPropose={remarkApi.proposeRemark} onResolve={remarkApi.resolveRemark} />;

  const thumbFailed = (id: SlideId): boolean => {
    const t = preview?.thumbs[id];
    return t !== undefined && failedThumbs.has(t.hash);
  };
  const urlFor = (id: SlideId): string | undefined => {
    const t = preview?.thumbs[id];
    if (t && failedThumbs.has(t.hash)) return FAILED_THUMB;
    if (t) return t.ready ? thumbUrl(t.hash) : undefined;
    return mainThumbs[id];
  };

  return (
    <div id={`lane-row-${lane.id}`} data-testid="lane-row" data-lane={lane.id} style={{ display: 'flex', alignItems: 'flex-start' }}>
      <div style={{ width: 120, flex: '0 0 120px' }} />
      <div
        data-testid="lane-grid"
        style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(mainOrder.length, 1)}, var(--thumb-w))`, columnGap: 'var(--col-gap)', padding: '0 6px' }}
      >
        <section
          data-testid="lane-region"
          data-col-start={region.start}
          data-col-span={region.span}
          aria-label={`lane ${lane.label}`}
          style={{ gridColumn: `${region.start + 1} / span ${region.span}`, minWidth: 0 }}
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
            // Same column widths and gap as the filmstrip: a cell's grid column is its main column.
            <div data-testid="lane-cells" style={{ display: 'grid', gridTemplateColumns: `repeat(${region.span}, var(--thumb-w))`, columnGap: 'var(--col-gap)', rowGap: 12 }}>
              {cells.map((cell) => (
                <div
                  key={`${cell.mark}:${cell.id}`}
                  data-testid="lane-cell"
                  data-slide={cell.id}
                  data-mark={cell.mark}
                  data-col={cell.col}
                  data-row={cell.row}
                  data-thumb-failed={thumbFailed(cell.id) ? 'true' : undefined}
                  style={{ position: 'relative', gridColumn: `${cell.col - region.start + 1}`, gridRow: `${cell.row}`, display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  {cell.mark === 'removed' ? (
                    <a
                      data-testid="removed-slot"
                      href={cell.changes[0] ? focusPath(lane.id, cell.changes[0].id) : undefined}
                      onClick={(e) => {
                        const first = cell.changes[0];
                        if (!first || e.metaKey || e.ctrlKey || e.shiftKey) return;
                        e.preventDefault();
                        onOpenChange(lane.id, first.id);
                      }}
                      title={`removed: ${cell.title}`}
                      style={{ width: 'var(--thumb-w)', height: 'var(--thumb-h)', borderRadius: 6, border: '1.5px dashed var(--grey-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--grey)', fontSize: 11, padding: 8, textAlign: 'center', textDecoration: 'none' }}
                    >
                      removed · {cell.title}
                    </a>
                  ) : (
                    <>
                      <Thumb
                        slideId={cell.id}
                        n={cell.mark === 'inserted' || cell.mark === 'moved' ? preview.order.indexOf(cell.id) + 1 : cell.col + 1}
                        title={cell.title}
                        url={urlFor(cell.id)}
                        selected={false}
                        onClick={() => {
                          if (thumbFailed(cell.id) && onRetryThumbs) {
                            onRetryThumbs(lane.id);
                            return;
                          }
                          // A changed slide opens its first pending change at reading size.
                          const first = cell.changes[0];
                          if (first) onOpenChange(lane.id, first.id);
                        }}
                      />
                      {cell.mark === 'inserted' ? (
                        <>
                          <div style={{ ...overlay, boxShadow: '0 0 0 2px var(--accent)' }} />
                          <div data-testid="insert-badge" style={{ ...overlay, width: 20, height: 20, top: 4, left: 'calc(var(--thumb-w) - 24px)', borderRadius: 999, background: 'var(--accent)', color: 'var(--card)', fontWeight: 700, fontSize: 14, lineHeight: '20px', textAlign: 'center' }}>+</div>
                        </>
                      ) : null}
                      {cell.mark === 'modified' ? <div data-testid="modified-dot" style={{ ...overlay, width: 8, height: 8, top: 6, left: 'calc(var(--thumb-w) - 14px)', borderRadius: 999, background: 'var(--accent)' }} /> : null}
                      {cell.mark === 'moved' ? <MoveConnector delta={mainOrder.indexOf(cell.id) - cell.col} /> : null}
                    </>
                  )}
                  {cell.changes.map((c) => (
                    <ChangeButtons key={c.id} change={c} disabled={busy} onAccept={accept} onRefuse={refuse} />
                  ))}
                  {(pinned.get(cell.id) ?? []).map(postIt)}
                </div>
              ))}
            </div>
          )}
          {preview && loose.length > 0 ? (
            <div data-testid="lane-remarks" style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {loose.map((r) => (
                <div key={r.id} style={{ width: 'var(--thumb-w)' }}>
                  {postIt(r)}
                </div>
              ))}
            </div>
          ) : null}
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
