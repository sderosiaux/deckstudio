import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import type { Anchor, Change, Lane, Remark, SlideId } from '../../../src/model/types.js';
import { focusPath, navigate, remarkApi as defaultRemarkApi, thumbUrl, type LaneApi, type LanePreviewPayload, type RemarkApi } from '../api.js';
import { ChangeButtons } from './ChangeButtons.js';
import { RemarkPostIt } from './Remark.js';
import { RemarkRow, type Pinned } from './RemarkRow.js';
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
  /** The lane's letter on main (A, B…), shown before its name in the gutter. */
  letter?: string;
  /** Deck columns in sight on main: the lane's remark cards stay inside them. */
  view?: { first: number; end: number };
  /** Columns the moved hairlines of lanes below run down: the lane's remark cards keep clear of them. */
  avoid?: ReadonlySet<number>;
}

// Shown in the thumb slot when the server reports a failed render; clicking that thumb re-requests it.
export const FAILED_THUMB = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#F3E3DD"/>' +
    '<text x="80" y="52" text-anchor="middle" font-family="system-ui,sans-serif" font-size="22" font-weight="600" fill="#B8432A">retry</text></svg>',
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
  /** 0-based main (deck) column the cell sits under. Every cell of a lane shares one row. */
  col: number;
  /** A dashed slot instead of a thumbnail: a removed slide, or the column a moved slide leaves. */
  slot: boolean;
  /** Moved slot only: the main column boundary the slide lands before (0 = before the first slide), and its 1-based position in the lane. */
  dest?: { boundary: number; at: number };
}

/** Slide fields a thumbnail never shows: a change to them alone renders the same slide. */
const OFF_SLIDE = ['story', 'notes'] as const;
export type OffSlideField = (typeof OFF_SLIDE)[number];

/**
 * The off-slide fields a modify rewrites when it touches nothing else ("story", "notes" or both, in that order), so its
 * lane card and its focus render as the slide on main. Empty for other kinds, or once any rendered field changes.
 */
export function offSlideFields(change: Change): OffSlideField[] {
  if (change.kind !== 'modify') return [];
  const keys = Object.keys(change.patch).filter((k) => change.patch[k as keyof typeof change.patch] !== undefined);
  if (keys.length === 0 || !keys.every((k) => (OFF_SLIDE as readonly string[]).includes(k))) return [];
  return OFF_SLIDE.filter((f) => keys.includes(f));
}

/** Off-slide fields every modify of a cell rewrites, when none of them changes the render; empty otherwise. */
function cellOffSlide(changes: readonly Change[]): OffSlideField[] {
  const modifies = changes.filter((c) => c.kind === 'modify');
  const each = modifies.map(offSlideFields);
  if (each.length === 0 || each.some((f) => f.length === 0)) return [];
  return OFF_SLIDE.filter((f) => each.some((fs) => fs.includes(f)));
}

/** The slide a change is about: the inserted slide's id, or the main slide it modifies, removes or moves. */
export const targetOf = (c: Change): SlideId => (c.kind === 'insert' ? c.slide.id : c.slide);

/**
 * The lane's slides laid in one row, each pinned to a main column:
 * - slides of the anchor range and any slide with a live change (even outside the range) sit under their own column;
 * - a removed slide, and a moved one, leave a dashed slot at their own column (a moved slot knows where the slide lands);
 * - an inserted slide takes the column right after the main slide it follows, or the next one a changed cell or slot
 *   does not hold (an unchanged context cell in the way yields: main already shows that slide).
 * Cells come sorted by column.
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
  const titleOf = (id: SlideId): string => preview.slides[id]?.title ?? id;

  // Boundary a displaced slide lands before: right after its change's `after` when that is in place on main, else
  // after the nearest preceding in-place slide of the preview (e.g. after another inserted slide), else the start.
  const boundaryOf = (id: SlideId, pos: number): number => {
    const c = (byTarget.get(id) ?? []).find((x) => x.kind === 'insert' || x.kind === 'move');
    const after = c && (c.kind === 'insert' || c.kind === 'move') ? c.after : undefined;
    if (after === null) return 0;
    if (after !== undefined && mainIndex.has(after) && !displaced(after)) return mainIndex.get(after)! + 1;
    for (let j = pos - 1; j >= 0; j--) {
      const prev = preview.order[j]!;
      if (!displaced(prev)) return mainIndex.get(prev)! + 1;
    }
    return 0;
  };

  const fixed: Cell[] = [];
  const floating: Array<{ id: SlideId; boundary: number }> = [];
  preview.order.forEach((id, pos) => {
    if (!range.has(id) && !byTarget.has(id)) return;
    const base = { id, title: titleOf(id), mark: markOf(id), changes: byTarget.get(id) ?? [] };
    if (!displaced(id)) fixed.push({ ...base, col: mainIndex.get(id)!, slot: false });
    else if (has(id, 'move') && mainIndex.has(id) && !has(id, 'insert')) {
      fixed.push({ ...base, col: mainIndex.get(id)!, slot: true, dest: { boundary: boundaryOf(id, pos), at: pos + 1 } });
    } else floating.push({ id, boundary: boundaryOf(id, pos) });
  });
  const inPreview = new Set(preview.order);
  for (const [i, id] of mainOrder.entries()) {
    if (inPreview.has(id) || !has(id, 'remove')) continue;
    fixed.push({ id, title: titleOf(id), mark: 'removed', changes: byTarget.get(id) ?? [], col: i, slot: true });
  }

  // Changed cells and slots hold their column; an unchanged context cell gives way to an inserted slide.
  const held = new Set(fixed.filter((c) => c.slot || c.mark !== 'none').map((c) => c.col));
  const placed: Cell[] = [];
  for (const f of floating) {
    let col = f.boundary;
    while (held.has(col)) col++;
    held.add(col);
    placed.push({ id: f.id, title: titleOf(f.id), mark: markOf(f.id), changes: byTarget.get(f.id) ?? [], col, slot: false });
  }
  const taken = new Set(placed.map((c) => c.col));
  return [...fixed.filter((c) => !taken.has(c.col)), ...placed].sort((a, b) => a.col - b.col);
}

/** Main columns a lane's moved hairlines run down (each moved slot's own column); none while the preview loads. */
export function movedColumns(lane: Lane, preview: LanePreviewPayload | undefined, mainOrder: SlideId[]): number[] {
  if (!preview) return [];
  const cols = anchorColumns(lane.anchor, mainOrder) ?? { start: 0, span: Math.max(mainOrder.length, 1) };
  return laneCells(lane, preview, mainOrder, cols).flatMap((c) => (c.dest ? [c.col] : []));
}

/** The columns the lane region covers: the anchor, widened to every cell's column. */
export function regionColumns(cols: { start: number; span: number }, cells: readonly Cell[]): { start: number; span: number } {
  const start = Math.min(cols.start, ...cells.map((c) => c.col));
  const end = Math.max(cols.start + cols.span - 1, ...cells.map((c) => c.col));
  return { start, span: end - start + 1 };
}

const overlay: CSSProperties = { position: 'absolute', top: 0, left: 0, width: 'var(--thumb-w)', height: 'var(--thumb-h)', pointerEvents: 'none', borderRadius: 4 };

/** "unsolicited, from check: arc" for a lane a check proposed; null for the creator's own. */
export function originTag(origin: Lane['origin']): string | null {
  return origin.startsWith('check:') ? `unsolicited, from check: ${origin.slice('check:'.length)}` : null;
}

/** Characters of a lane name the 120px gutter holds on two lines at the row-label size. */
const SHORT_CHARS = 24;

/** A lane name cut at a word boundary to fit the gutter ("Pull the decision-layer detour…" → "Pull the decision-layer"); the full name stays in the tooltip. */
export function shortLabel(label: string, max = SHORT_CHARS): string {
  const words = label.trim().split(/\s+/);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || label.slice(0, max);
}

/** Letter naming the n-th open lane on main: A, B, … Z, then AA, AB… */
export function laneLetter(i: number): string {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return i < a.length ? a[i]! : laneLetter(Math.floor(i / a.length) - 1) + a[i % a.length]!;
}

/**
 * Accept, refuse or discard on one lane, one call at a time: `busy` while a call runs, `error` holds the server's
 * message of the last failed one. Shared by every place that decides a lane's changes.
 */
export function useLaneActions(laneId: string, api: LaneApi) {
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
  return {
    busy,
    error,
    accept: (changeId: string): void => void run(() => api.acceptChange(laneId, changeId)),
    refuse: (changeId: string): void => void run(() => api.refuseChange(laneId, changeId)),
    discard: (): void => void run(() => api.discardLane(laneId)),
  };
}

/**
 * One open lane, laid out under main: its name in the gutter, then the same column grid as the filmstrip, where the
 * lane occupies only the columns it touches, so each proposed slide sits under the slide it replaces.
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
  letter,
  view,
  avoid,
}: LaneRowProps) {
  const { busy, error, accept, refuse, discard } = useLaneActions(lane.id, api);

  const anchored = anchorColumns(lane.anchor, mainOrder);
  const n = Math.max(mainOrder.length, 1);
  const cols = anchored ?? { start: 0, span: n };
  const allCells = preview ? laneCells(lane, preview, mainOrder, cols) : [];
  // A whole-deck lane shows only the slides it touches: its untouched slides are main's, already in the row above.
  const cells = lane.anchor.kind === 'arc' && allCells.some((c) => c.mark !== 'none') ? allCells.filter((c) => c.mark !== 'none') : allCells;
  const region = lane.anchor.kind === 'arc' && cells.length > 0 ? regionColumns({ start: cells[0]!.col, span: 1 }, cells) : regionColumns(cols, cells);
  const skipped = preview ? lane.changes.filter((c) => c.status === 'pending' && preview.skipped.includes(c.id)) : [];
  const tag = originTag(lane.origin);
  // Remarks go on the grid under the cell they point at; the rest (arc, or a slide not in the row) under the first cell.
  const cellCol = new Map(cells.map((c) => [c.id, c.col] as const));
  const pinned: Pinned[] = remarks.map((r) => {
    const id = remarkSlide(r.anchor, preview?.order ?? []);
    const col = id !== null ? cellCol.get(id) : undefined;
    return {
      id: r.id,
      col: col ?? region.start,
      span: 1,
      slide: col !== undefined ? id! : undefined,
      card: <RemarkPostIt remark={r} onPropose={remarkApi.proposeRemark} onResolve={remarkApi.resolveRemark} />,
    };
  });

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

  const openCell = (cell: Cell): void => {
    if (thumbFailed(cell.id) && onRetryThumbs) {
      onRetryThumbs(lane.id);
      return;
    }
    // A changed slide opens its first pending change at reading size.
    const first = cell.changes[0];
    if (first) onOpenChange(lane.id, first.id);
  };
  const thumbOf = (cell: Cell, hoverTitle = true) => (
    <Thumb
      slideId={cell.id}
      n={cell.mark === 'inserted' || cell.mark === 'moved' ? preview!.order.indexOf(cell.id) + 1 : cell.col + 1}
      title={cell.title}
      url={urlFor(cell.id)}
      selected={false}
      numbered={false}
      hoverTitle={hoverTitle}
      onClick={() => openCell(cell)}
    />
  );

  return (
    <div id={`lane-row-${lane.id}`} data-testid="lane-row" data-lane={lane.id} style={{ display: 'flex', alignItems: 'stretch' }}>
      <div className="gutter" style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8 }}>
        <span className="row-label" title={lane.label} data-testid="lane-name">
          {letter ? <strong style={{ fontWeight: 700, marginRight: 6 }}>{letter}</strong> : null}
          {shortLabel(lane.label)}
        </span>
        {tag ? <span className="meta">{tag}</span> : null}
        {anchored ? null : <span className="meta">anchor no longer on main</span>}
        <button type="button" className="link" disabled={busy} onClick={discard} style={{ fontSize: 12, alignSelf: 'flex-start' }}>
          discard lane
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div data-testid="lane-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, var(--thumb-w))`, gridAutoColumns: 'var(--thumb-w)', columnGap: 'var(--col-gap)', padding: '0 6px' }}>
          <section
            data-testid="lane-region"
            data-col-start={region.start}
            data-col-span={region.span}
            aria-label={`lane ${lane.label}`}
            style={{ gridColumn: `${region.start + 1} / span ${region.span}`, minWidth: 0, paddingTop: 6 }}
          >
            {error ? (
              <p role="alert" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--warn)', width: 'max-content', maxWidth: 480 }}>
                {error}
              </p>
            ) : null}
            {!preview ? (
              <p className="meta" style={{ margin: 0, width: 'max-content' }}>Loading lane preview…</p>
            ) : (
              // Same column widths and gap as the filmstrip: a cell's grid column is its main column.
              // Two rows shared by every cell (subgrid): the cards, as tall as the tallest moved slot, then the ✓ ✗ pairs on one line.
              <div data-testid="lane-cells" data-edge-row style={{ display: 'grid', gridTemplateColumns: `repeat(${region.span}, var(--thumb-w))`, gridTemplateRows: 'auto auto', gridAutoColumns: 'var(--thumb-w)', columnGap: 'var(--col-gap)', rowGap: 12 }}>
                {cells.map((cell) => (
                  <div
                    key={`${cell.mark}:${cell.id}`}
                    data-testid="lane-cell"
                    data-slide={cell.id}
                    data-mark={cell.mark}
                    data-col={cell.col}
                    data-thumb-failed={thumbFailed(cell.id) ? 'true' : undefined}
                    data-edge-item
                    // No numbers under lane cells (main's row above numbers the columns): every ✓ ✗ pair sits 12px under the cards.
                    style={{ position: 'relative', gridColumn: `${cell.col - region.start + 1}`, gridRow: '1 / span 2', display: 'grid', gridTemplateRows: 'subgrid', alignItems: 'start' }}
                  >
                    {cell.dest ? (
                      <div data-testid="moved-slot" role="group" aria-label={`moved: ${cell.title}, now slide ${cell.dest.at}`} style={movedStyle}>
                        <MoveMark />
                        {thumbOf(cell, false)}
                        <span style={{ lineHeight: '16px', marginTop: 6, whiteSpace: 'nowrap' }}>moved to {cell.dest.at}</span>
                        <span data-testid="moved-title" title={cell.title} style={movedTitle}>
                          {cell.title}
                        </span>
                      </div>
                    ) : cell.slot ? (
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
                        aria-label={`removed: ${cell.title}`}
                        className="edge-frame"
                        style={removedStyle}
                      >
                        removed
                      </a>
                    ) : (
                      <>
                        {thumbOf(cell)}
                        {cell.mark === 'inserted' ? (
                          <>
                            <div style={{ ...overlay, boxShadow: '0 0 0 1.5px var(--accent)' }} />
                            <div data-testid="insert-badge" style={{ ...overlay, width: 14, height: 14, top: 3, left: 'calc(var(--thumb-w) - 17px)', borderRadius: 999, background: 'var(--accent)', color: 'var(--card)', fontWeight: 700, fontSize: 12, lineHeight: '14px', textAlign: 'center' }}>+</div>
                          </>
                        ) : null}
                        {cell.mark === 'modified' ? <ModifiedMark fields={cellOffSlide(cell.changes)} /> : null}
                      </>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {cell.changes.map((c) => (
                        <ChangeButtons key={c.id} change={c} disabled={busy} onAccept={accept} onRefuse={refuse} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {skipped.length > 0 ? (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, width: 'max-content' }}>
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
        {preview && pinned.length > 0 ? <RemarkRow testId="lane-remarks" items={pinned} columns={n} view={view} avoid={avoid} /> : null}
      </div>
    </div>
  );
}

/** Where the moved hairline runs, from the left edge of its column: the same x on main's thumb and in the lane slot, clear of the card's rounded corner. */
const MOVE_X = 8;

const slotBox: CSSProperties = {
  position: 'relative',
  width: 'var(--thumb-w)',
  minHeight: 'var(--thumb-h)',
  borderRadius: 4,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--grey)',
  fontSize: 'var(--fs-meta)',
  textDecoration: 'none',
};
/** The dashed outline means "removed", and only that. */
const removedStyle: CSSProperties = { ...slotBox, height: 'var(--thumb-h)', border: '1px dashed var(--accent)' };
/** A moved slide's old column: its card, the hairline from main's thumb landing on the card's top edge, the words under it. */
const movedStyle: CSSProperties = { ...slotBox, alignItems: 'stretch', justifyContent: 'flex-start' };
/** The moved slide's title: at most two 12px lines in the one column, the whole title in the tooltip. */
const movedTitle: CSSProperties = {
  fontWeight: 500,
  lineHeight: '16px',
  color: 'var(--ink)',
  overflowWrap: 'break-word',
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
};

/**
 * Where the accent hairline that leaves the slide's thumb on main (drawn by MoveRisers down to the slot's top) lands:
 * a dot on the top edge of the moved slide's card, which sits in its old column with "moved to 24" and its title under it.
 */
function MoveMark() {
  return (
    <span
      data-testid="move-connector"
      aria-hidden
      style={{ position: 'absolute', zIndex: 1, top: -2, left: MOVE_X - 2, width: 5, height: 5, borderRadius: 999, background: 'var(--accent)', pointerEvents: 'none' }}
    />
  );
}

/**
 * The accent dot on a modified card. A modify that only rewrites the story or the notes renders the same slide: the
 * dot then carries those words in a small muted tag, so an identical card does not read as a missing diff.
 */
function ModifiedMark({ fields }: { fields: readonly OffSlideField[] }) {
  const dot = <span data-testid="modified-dot" style={{ width: 7, height: 7, flex: '0 0 7px', borderRadius: 999, background: 'var(--accent)' }} />;
  if (fields.length === 0) return <div style={{ ...overlay, width: 7, height: 7, top: 4, left: 'calc(var(--thumb-w) - 11px)', display: 'flex' }}>{dot}</div>;
  return (
    <div
      data-testid="modified-tag-box"
      style={{ ...overlay, width: 'auto', height: 'auto', left: 'auto', right: 3, top: 3, display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px 0 5px', borderRadius: 999, background: 'var(--paper)', boxShadow: '0 0 0 1px var(--line)' }}
    >
      <span data-testid="modified-tag" className="meta" style={{ lineHeight: '14px' }}>{fields.join(', ')}</span>
      {dot}
    </div>
  );
}

interface Riser {
  key: string;
  x: number;
  top: number;
  height: number;
}

/**
 * The vertical part of every moved mark under `root`: a 1px accent hairline from the bottom of the slide's thumb on
 * main down to its slot in the lane row. Drawn behind the rows, measured
 * from the laid out strip, so it follows the column width and whatever sits between main and the lane. The remark
 * cards in between keep clear of its column (placeCards' avoid), so the line reads unbroken.
 * `root` must be positioned and form a stacking context (z-index 0) so the hairlines can sit under its rows.
 */
export function MoveRisers({ root, deps }: { root: RefObject<HTMLElement | null>; deps: readonly unknown[] }) {
  const [risers, setRisers] = useState<Riser[]>([]);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const update = (): void => {
      frame = 0;
      const box = el.getBoundingClientRect();
      const next = [...el.querySelectorAll<HTMLElement>('[data-testid="moved-slot"]')].flatMap((slot, i) => {
        const id = slot.closest('[data-testid="lane-cell"]')?.getAttribute('data-slide');
        const thumb = id ? el.querySelector(`[data-strip="main"] [data-testid="thumb"][data-slide="${CSS.escape(id)}"] .edge-frame`) : null;
        if (!thumb) return [];
        const from = thumb.getBoundingClientRect();
        const to = slot.getBoundingClientRect();
        if (to.top <= from.bottom) return [];
        return [{ key: `${id}:${i}`, x: Math.round(to.left - box.left + MOVE_X), top: Math.round(from.bottom - box.top), height: Math.round(to.top - from.bottom) }];
      });
      setRisers((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
    mo?.observe(el, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [root, ...deps]);
  return (
    <>
      {risers.map((r) => (
        <span
          key={r.key}
          data-testid="move-riser"
          aria-hidden
          style={{ position: 'absolute', zIndex: -1, left: r.x, top: r.top, width: 1, height: r.height, background: 'var(--accent)', pointerEvents: 'none' }}
        />
      ))}
    </>
  );
}
