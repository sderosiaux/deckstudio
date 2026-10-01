import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { Anchor, Change, Lane, Remark, Slide, SlideId, SlidePatch } from '../../../src/model/types.js';
import { focusPath, navigate, remarkApi as defaultRemarkApi, thumbUrl, type LaneApi, type LaneChange, type LanePayload, type LanePreviewPayload, type RemarkApi } from '../api.js';
import { ChangeButtons, settledNote } from './ChangeButtons.js';
import { RemarkPostIt, anchorLabel } from './Remark.js';
import { Thumb } from './Thumb.js';

export interface LaneRowProps {
  lane: Lane;
  /** Undefined while loading. */
  preview: LanePreviewPayload | undefined;
  mainOrder: SlideId[];
  /** Main's slides: names a removed slide, which the lane preview no longer holds. */
  mainSlides?: Record<SlideId, Slide>;
  /** Thumbnails of main, reused for the lane's unchanged slides. */
  mainThumbs: Record<SlideId, string | undefined>;
  api: LaneApi;
  /** Opens the focus screen on a change; defaults to the client-side route. */
  onOpenChange?(laneId: string, changeId: string): void;
  /** Preview thumb hashes whose render failed: those cells show the failed card, clicking it retries. */
  failedThumbs?: ReadonlySet<string>;
  /** Re-requests the lane preview, which re-enqueues its thumbnails. */
  onRetryThumbs?(laneId: string): void;
  /** Open remarks raised by a check on this lane's content (`sourceLaneId === lane.id`): a count in the gutter, listed on demand. */
  remarks?: readonly Remark[];
  remarkApi?: RemarkApi;
  /** Deck columns in sight on main: when every changed slide lies outside, an edge chip points at the nearest one. */
  view?: { first: number; end: number };
  /** Scrolls main's strip so that this 0-based column is in view (the edge chip). */
  onReveal?(col: number): void;
  /** The row was just created or revised from a request: an accent outline that fades once. */
  flash?: boolean;
  onFlashEnd?(laneId: string): void;
}

// Shown in the thumb slot when the server reports a failed render; clicking that thumb re-requests it.
export const FAILED_THUMB = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#F3E3DD"/>' +
    '<text x="80" y="52" text-anchor="middle" font-family="system-ui,sans-serif" font-size="22" font-weight="600" fill="#B8432A">retry</text></svg>',
)}`;

const NO_FAILED: ReadonlySet<string> = new Set();
const NO_REMARKS: readonly Remark[] = [];
/** Empty columns in view before a lane's first cell that take its name instead of the gutter: three hold a line of it. */
const SPILL_MIN = 3;
/** Pending changes a spilled lane lists down a column under its name (two lines each), in as many 300px+ columns as its width holds. */
const SPILL_LINES = 4;
const SPILL_COL = 300;
const SPILL_COL_GAP = 24;

/**
 * A lane's name spilled from the gutter into the empty columns after it (like a ledger line running into empty cells):
 * the name, its origin and actions, then what the lane does, change by change, in columns under 80 characters; a
 * click opens a change at reading size. It sits in the sticky gutter and runs `columns` deck columns past it, ending
 * 12px before the lane's first cell.
 */
function LaneSpill({
  columns,
  name,
  meta,
  changes,
  onOpen,
}: {
  columns: number;
  name: ReactNode;
  meta: ReactNode;
  changes: readonly { id: string; what: string; reason: string }[];
  onOpen(changeId: string): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = (): void => setCols(Math.max(1, Math.floor((el.clientWidth + SPILL_COL_GAP) / (SPILL_COL + SPILL_COL_GAP))));
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const room = SPILL_LINES * cols;
  const shown = changes.length > room ? changes.slice(0, room - 1) : changes;
  const rest = changes.length - shown.length;
  // Down a column first (the row is as tall as its cards anyway), then the next column.
  const items = shown.length + (rest > 0 ? 1 : 0);
  const lines = Math.min(SPILL_LINES, items);
  const used = Math.ceil(items / Math.max(1, lines));
  return (
    <div
      ref={box}
      data-testid="lane-spill"
      data-columns={columns}
      // The gutter's 120px, the rows' 6px of padding, the empty columns, less 20px short of the first cell.
      style={{ width: `calc(var(--gutter) + 6px + ${columns} * (var(--thumb-w) + var(--col-gap)) - 20px)`, display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      <div style={{ maxWidth: '80ch' }}>{name}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 12, rowGap: 4 }}>{meta}</div>
      {changes.length > 0 ? (
        <ul
          data-testid="lane-spill-changes"
          style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gridTemplateColumns: `repeat(${used}, minmax(0, 80ch))`, gridTemplateRows: `repeat(${lines}, auto)`, gridAutoFlow: 'column', gap: `4px ${SPILL_COL_GAP}px` }}
        >
          {shown.map((c) => (
            <li key={c.id} style={{ minWidth: 0, maxWidth: '80ch' }}>
              <button
                type="button"
                className="link"
                title={`${c.what}: ${c.reason}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(c.id);
                }}
                // Two lines at most: the change and as much of its reason as they hold (the title has it whole).
                style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, maxWidth: '100%', overflow: 'hidden', lineHeight: '18px', color: 'var(--ink)', textAlign: 'left' }}
              >
                {c.what}
                <span className="muted">: {c.reason}</span>
              </button>
            </li>
          ))}
          {rest > 0 ? (
            <li className="meta" style={{ lineHeight: '18px' }}>
              {rest} more {rest === 1 ? 'change' : 'changes'}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
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

/** `settled`: a slide whose changes in this lane are all decided (accepted, refused) or stale, none pending. */
type Mark = 'inserted' | 'modified' | 'moved' | 'removed' | 'settled';
export interface Cell {
  id: SlideId;
  title: string;
  mark: Mark;
  /** The pending changes on the slide; for a settled cell, its decided ones. */
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
 * The lane's own slides laid in one row, each pinned to a main column. A slide gets a cell only for a change of the
 * lane: an unchanged slide of main never shows in a lane row (main's row above already shows it).
 * - a slide with a live change sits under its own column;
 * - a removed slide, and a moved one, leave a dashed slot at their own column (a moved slot knows where the slide lands);
 * - a slide whose changes are all decided or stale (accepted, refused, orphan) keeps its column on main, as a settled
 *   cell; a decided change whose slide has no column on main (an accepted removal) has no cell;
 * - an inserted slide takes the column right after the main slide it follows, or the next one no other cell holds.
 * Cells come sorted by column.
 */
export function laneCells(lane: Lane, preview: LanePreviewPayload, mainOrder: SlideId[], mainSlides?: Record<SlideId, Slide>): Cell[] {
  const skipped = new Set(preview.skipped);
  const live = lane.changes.filter((c) => c.status === 'pending' && !skipped.has(c.id));
  const byTarget = new Map<SlideId, Change[]>();
  for (const c of live) byTarget.set(targetOf(c), [...(byTarget.get(targetOf(c)) ?? []), c]);
  // Decided changes on slides with no live change left: one settled cell per slide.
  const decided = new Map<SlideId, Change[]>();
  for (const c of lane.changes) {
    if (c.status === 'pending' || byTarget.has(targetOf(c))) continue;
    decided.set(targetOf(c), [...(decided.get(targetOf(c)) ?? []), c]);
  }
  const has = (id: SlideId, kind: Change['kind']): boolean => (byTarget.get(id) ?? []).some((c) => c.kind === kind);
  const mainIndex = new Map(mainOrder.map((id, i) => [id, i] as const));
  const displaced = (id: SlideId): boolean => has(id, 'insert') || has(id, 'move') || !mainIndex.has(id);

  const markOf = (id: SlideId): Mark => (has(id, 'insert') ? 'inserted' : has(id, 'move') ? 'moved' : has(id, 'remove') ? 'removed' : 'modified');
  // A removed slide is gone from the preview: main still has its title; a refused insert only its change has.
  const titleOf = (id: SlideId): string => {
    const inserted = (decided.get(id) ?? []).find((c) => c.kind === 'insert');
    return preview.slides[id]?.title ?? mainSlides?.[id]?.title ?? (inserted?.kind === 'insert' ? inserted.slide.title : id);
  };

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
  const floating: Array<{ id: SlideId; boundary: number; settled: boolean }> = [];
  preview.order.forEach((id, pos) => {
    if (!byTarget.has(id)) return;
    const base = { id, title: titleOf(id), mark: markOf(id), changes: byTarget.get(id)! };
    if (!displaced(id)) fixed.push({ ...base, col: mainIndex.get(id)!, slot: false });
    else if (has(id, 'move') && mainIndex.has(id) && !has(id, 'insert')) {
      fixed.push({ ...base, col: mainIndex.get(id)!, slot: true, dest: { boundary: boundaryOf(id, pos), at: pos + 1 } });
    } else floating.push({ id, boundary: boundaryOf(id, pos), settled: false });
  });
  const inPreview = new Set(preview.order);
  for (const [i, id] of mainOrder.entries()) {
    if (inPreview.has(id) || !has(id, 'remove')) continue;
    fixed.push({ id, title: titleOf(id), mark: 'removed', changes: byTarget.get(id) ?? [], col: i, slot: true });
  }
  for (const [id, changes] of decided) {
    const at = mainIndex.get(id);
    if (at !== undefined) {
      fixed.push({ id, title: titleOf(id), mark: 'settled', changes, col: at, slot: false });
      continue;
    }
    // A refused or stale insert never reached main: it stays where it would have landed.
    const insert = changes.find((c) => c.kind === 'insert');
    if (insert?.kind !== 'insert') continue;
    const boundary = insert.after === null ? 0 : mainIndex.get(insert.after);
    if (boundary !== undefined) floating.push({ id, boundary: insert.after === null ? 0 : boundary + 1, settled: true });
  }

  // Every fixed cell holds its column; an inserted slide takes the next free one, a pending insert before a settled one.
  const held = new Set(fixed.map((c) => c.col));
  const placed: Cell[] = [];
  for (const f of [...floating.filter((x) => !x.settled), ...floating.filter((x) => x.settled)]) {
    let col = f.boundary;
    while (held.has(col)) col++;
    held.add(col);
    placed.push(
      f.settled
        ? { id: f.id, title: titleOf(f.id), mark: 'settled', changes: decided.get(f.id)!, col, slot: false }
        : { id: f.id, title: titleOf(f.id), mark: markOf(f.id), changes: byTarget.get(f.id)!, col, slot: false },
    );
  }
  return [...fixed, ...placed].sort((a, b) => a.col - b.col);
}

/** How a settled cell reads: accepted when any of its changes went to main, else refused, else stale. */
export function settledKind(changes: readonly Change[]): 'accepted' | 'refused' | 'stale' {
  if (changes.some((c) => c.status === 'accepted')) return 'accepted';
  if (changes.some((c) => c.status === 'refused')) return 'refused';
  return 'stale';
}

/** Main columns a lane's moved hairlines run down (each moved slot's own column); none while the preview loads. */
export function movedColumns(lane: Lane, preview: LanePreviewPayload | undefined, mainOrder: SlideId[]): number[] {
  if (!preview) return [];
  return laneCells(lane, preview, mainOrder).flatMap((c) => (c.dest ? [c.col] : []));
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

/** The label the history screen gives a lane opened from a past version ("back to v4", historyService.openAsLane). */
const HISTORY_LABEL = /^back to v(\d+)$/;

/** Where a lane comes from, under its name: "from check: arc", "from history v4", "from your request on slide 2". */
export function laneOrigin(lane: Pick<Lane, 'origin' | 'label' | 'anchor'>, mainOrder: SlideId[]): string {
  if (lane.origin.startsWith('check:')) return `from check: ${lane.origin.slice('check:'.length)}`;
  const past = HISTORY_LABEL.exec(lane.label);
  if (past && lane.anchor.kind === 'arc') return `from history v${past[1]}`;
  if (lane.anchor.kind === 'arc') return 'from your request on the whole deck';
  if (!anchorColumns(lane.anchor, mainOrder)) return 'from your request';
  return `from your request on ${anchorLabel(lane.anchor, mainOrder)}`;
}

/**
 * A change in the creator's words, for the accessible names of its buttons: "modify slide 3, Hook". Main numbers for a
 * slide on main, the lane's position for an inserted one; never an id.
 */
export function describeChange(c: Change, mainOrder: SlideId[], preview: LanePreviewPayload | undefined, mainSlides?: Record<SlideId, Slide>): string {
  const id = targetOf(c);
  const title = c.kind === 'insert' ? c.slide.title : (preview?.slides[id]?.title ?? mainSlides?.[id]?.title ?? 'a slide');
  const onMain = mainOrder.indexOf(id);
  const inLane = preview ? preview.order.indexOf(id) : -1;
  const at = c.kind === 'insert' ? inLane : onMain;
  const where = at >= 0 ? `slide ${at + 1}, ${title}` : title;
  return c.kind === 'move' && inLane >= 0 ? `move ${where}, to ${inLane + 1}` : `${c.kind} ${where}`;
}

/** A decision the row shows before the server confirms it: the change's id and the status it is given. */
export type Optimistic = Readonly<Record<string, 'accepted' | 'refused'>>;

/** The lane as the creator just decided it: each pending change clicked takes its decided status at once. */
export function withDecisions(lane: Lane, decided: Optimistic): Lane {
  if (!lane.changes.some((c) => c.status === 'pending' && decided[c.id])) return lane;
  return { ...lane, changes: lane.changes.map((c) => (c.status === 'pending' && decided[c.id] ? { ...c, status: decided[c.id]! } : c)) };
}

/**
 * A change on one short line for the 120px header column: "move slide 17 to 9", "modify slide 3", "insert slide 4"
 * (main's number for a slide on main, the lane's for a new one or a move's landing).
 */
export function shortChange(c: Change, mainOrder: SlideId[], preview: LanePreviewPayload | undefined): string {
  const id = targetOf(c);
  const onMain = mainOrder.indexOf(id);
  const inLane = preview ? preview.order.indexOf(id) : -1;
  if (c.kind === 'insert') return inLane >= 0 ? `insert slide ${inLane + 1}` : `insert ${c.slide.title}`;
  const where = onMain >= 0 ? `slide ${onMain + 1}` : 'a slide';
  return c.kind === 'move' && inLane >= 0 ? `move ${where} to ${inLane + 1}` : `${c.kind} ${where}`;
}

/**
 * Accept, refuse or discard on one lane, one call at a time: `busy` while a call runs, `error` holds the server's
 * message of the last failed one. Shared by every place that decides a lane's changes.
 */
export function useLaneActions(laneId: string, api: LaneApi) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    error,
    /** Accepts or refuses one change; resolves to whether the server took it. */
    decide: (verb: 'accept' | 'refuse', changeId: string): Promise<boolean> =>
      run(() => (verb === 'accept' ? api.acceptChange(laneId, changeId) : api.refuseChange(laneId, changeId))),
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
  lane: serverLane,
  preview,
  mainOrder,
  mainThumbs,
  api,
  onOpenChange = openFocus,
  failedThumbs = NO_FAILED,
  onRetryThumbs,
  remarks = NO_REMARKS,
  remarkApi = defaultRemarkApi,
  view,
  onReveal,
  flash = false,
  onFlashEnd,
  mainSlides,
}: LaneRowProps) {
  const { busy, error, decide, discard } = useLaneActions(serverLane.id, api);
  // Decisions shown at once, before the server's lane.updated: dropped once the server's lane has the change decided,
  // or when the call fails.
  const [decided, setDecided] = useState<Optimistic>({});
  useEffect(() => {
    setDecided((prev) => {
      const keep = Object.entries(prev).filter(([id]) => serverLane.changes.find((c) => c.id === id)?.status === 'pending');
      return keep.length === Object.keys(prev).length ? prev : Object.fromEntries(keep);
    });
  }, [serverLane]);
  const lane = withDecisions(serverLane, decided);
  const decideNow = (verb: 'accept' | 'refuse') => (changeId: string): void => {
    setDecided((prev) => ({ ...prev, [changeId]: verb === 'accept' ? 'accepted' : 'refused' }));
    void decide(verb, changeId).then((ok) => {
      if (!ok)
        setDecided((prev) => {
          const { [changeId]: _dropped, ...rest } = prev;
          return rest;
        });
    });
  };
  const accept = decideNow('accept');
  const refuse = decideNow('refuse');
  const [remarksOpen, setRemarksOpen] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  // A native listener: the flash ends with its CSS animation, however the browser names that event to React.
  useEffect(() => {
    const el = row.current;
    if (!el || !flash || !onFlashEnd) return;
    const end = (): void => onFlashEnd(lane.id);
    el.addEventListener('animationend', end);
    return () => el.removeEventListener('animationend', end);
  }, [flash, onFlashEnd, lane.id]);

  const anchored = anchorColumns(lane.anchor, mainOrder);
  const n = Math.max(mainOrder.length, 1);
  const cols = anchored ?? { start: 0, span: n };
  const cells = preview ? laneCells(lane, preview, mainOrder, mainSlides) : [];
  // A whole-deck lane starts at the first slide it touches, not at the first column of the deck.
  const region = lane.anchor.kind === 'arc' && cells.length > 0 ? regionColumns({ start: cells[0]!.col, span: 1 }, cells) : regionColumns(cols, cells);
  const skipped = preview ? lane.changes.filter((c) => c.status === 'pending' && preview.skipped.includes(c.id)) : [];
  const origin = laneOrigin(lane, mainOrder);
  const describe = (c: Change): string => describeChange(c, mainOrder, preview, mainSlides);
  const edge = edgeTarget(cells, view);

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
    // A changed slide opens its first pending change at reading size; a settled one has nothing left to decide.
    if (cell.mark === 'settled') return;
    const first = cell.changes[0];
    if (first) onOpenChange(lane.id, first.id);
  };
  /** The moved slot's link: a plain click opens the change in focus (or retries a failed thumb); a modified click is the browser's. */
  const followMoved = (e: MouseEvent<HTMLAnchorElement>, cell: Cell): void => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openCell(cell);
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

  // The empty columns in view before the lane's first cell: three or more, and the lane's name, origin and actions
  // spill into them on one line each (a ledger line), instead of wrapping five lines deep in the 120px gutter.
  const spillFrom = view ? view.first : 0;
  const spillTo = view ? Math.min(region.start, view.end) : 0;
  const spill = view !== undefined && spillTo - spillFrom >= SPILL_MIN;
  const pending = lane.changes.filter((c) => c.status === 'pending' && !skipped.includes(c));
  /* The whole title, wrapped: a lane is what the creator decides on, its name is never cut. */
  const name = (
    <span className="row-label" data-testid="lane-name" style={{ overflowWrap: 'anywhere' }}>
      {lane.label}
    </span>
  );
  const originTag = <span className="meta" data-testid="lane-origin">{origin}</span>;
  const lost = anchored ? null : <span className="meta">anchor no longer on main</span>;
  const discardBtn = (
    <button
      type="button"
      className="link"
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        discard();
      }}
      style={{ fontSize: 12, alignSelf: 'flex-start' }}
    >
      discard lane
    </button>
  );
  const remarksBtn =
    remarks.length > 0 ? (
      <button
        type="button"
        className="link"
        aria-expanded={remarksOpen}
        onClick={(e) => {
          e.stopPropagation();
          setRemarksOpen((o) => !o);
        }}
        style={{ fontSize: 12, alignSelf: 'flex-start' }}
      >
        {remarks.length} check {remarks.length === 1 ? 'remark' : 'remarks'}
      </button>
    ) : null;
  const chip =
    edge && onReveal ? (
      <button
        type="button"
        className="link edge-chip"
        data-testid="edge-chip"
        data-side={edge.side}
        title={edge.side === 'right' ? 'further on in the strip' : 'earlier in the strip'}
        onClick={(e) => {
          e.stopPropagation();
          onReveal(edge.col);
        }}
      >
        {edge.side === 'left' ? <span aria-hidden>‹ </span> : null}
        slide {edge.col + 1}
        {edge.side === 'right' ? <span aria-hidden> ›</span> : null}
      </button>
    ) : null;

  return (
    <div
      id={`lane-row-${lane.id}`}
      data-testid="lane-row"
      data-lane={lane.id}
      data-flash={flash ? 'true' : undefined}
      className={flash ? 'lane-row lane-flash' : 'lane-row'}
      ref={row}
      style={{ display: 'flex', alignItems: 'stretch' }}
    >
      <div className="gutter" style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8 }}>
        {spill ? (
          <LaneSpill
            columns={spillTo - spillFrom}
            name={name}
            meta={
              <>
                {originTag}
                {lost}
                {discardBtn}
                {remarksBtn}
                {chip}
              </>
            }
            changes={pending.map((c) => ({ id: c.id, what: describe(c), reason: c.reason }))}
            onOpen={(id) => onOpenChange(lane.id, id)}
          />
        ) : (
          <>
            {name}
            {originTag}
            {lost}
            {discardBtn}
            {remarksBtn}
            {chip}
            {chip && pending.length > 0 ? (
              // The changed cells lie outside the columns in view: what the lane does, one change a line, each a link to it.
              <ul data-testid="lane-offscreen" style={{ listStyle: 'none', margin: '2px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {pending.map((c) => {
                  const href = focusPath(lane.id, c.id);
                  return (
                    <li key={c.id}>
                      <a
                        href={href}
                        title={`${describe(c)}: ${c.reason}`}
                        className="link"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                          e.preventDefault();
                          onOpenChange(lane.id, c.id);
                        }}
                        style={{ fontSize: 'var(--fs-meta)', lineHeight: '16px', color: 'var(--ink)' }}
                      >
                        {shortChange(c, mainOrder, preview)}
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div data-testid="lane-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, var(--thumb-w))`, gridAutoColumns: 'var(--thumb-w)', columnGap: 'var(--col-gap)', padding: '0 6px' }}>
          <section
            data-testid="lane-region"
            data-col-start={region.start}
            data-col-span={region.span}
            aria-label={`lane ${lane.label}`}
            style={{ gridColumn: `${region.start + 1} / span ${region.span}`, gridRow: '1', minWidth: 0, paddingTop: 6 }}
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
                    // The row's "+N" counts pending changes: a settled cell is covered at the edge but never counted.
                    data-edge-weight={cell.mark === 'settled' ? 0 : cell.changes.length}
                    // No numbers under lane cells (main's row above numbers the columns): every ✓ ✗ pair sits 12px under the cards.
                    style={{ position: 'relative', gridColumn: `${cell.col - region.start + 1}`, gridRow: '1 / span 2', display: 'grid', gridTemplateRows: 'subgrid', alignItems: 'start' }}
                  >
                    {cell.dest ? (
                      <div data-testid="moved-slot" role="group" aria-label={`moved: ${cell.title}, now slide ${cell.dest.at}`} style={movedStyle}>
                        <MoveMark />
                        {/* The whole slot opens the move in focus: its card, "moved to N" and the title. */}
                        <a
                          className="moved-open"
                          href={cell.changes[0] ? focusPath(lane.id, cell.changes[0].id) : undefined}
                          aria-label={`open in focus: move slide ${cell.col + 1} (${cell.title})`}
                          onClick={(e) => followMoved(e, cell)}
                          style={movedLink}
                        >
                          <SlideCard url={urlFor(cell.id)} />
                          <span style={{ lineHeight: '16px', marginTop: 6, whiteSpace: 'nowrap' }}>moved to {cell.dest.at}</span>
                          <span data-testid="moved-title" title={cell.title} style={movedTitle}>
                            {cell.title}
                          </span>
                        </a>
                      </div>
                    ) : cell.mark === 'settled' ? (
                      // Decided: the slide as it stands, a refused or stale one dimmed; the tag under it says which.
                      <div data-testid="settled-card" data-settled={settledKind(cell.changes)} style={settledKind(cell.changes) === 'accepted' ? undefined : { opacity: 0.45 }}>
                        {thumbOf(cell)}
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
                        {cell.mark === 'modified' ? <ModifiedDot /> : null}
                      </>
                    )}
                    {/* Under the card: the ✓ ✗ pairs, and what a story or notes rewrite touches, never over the slide. */}
                    <div data-testid="change-line" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {cell.mark === 'settled'
                        ? cell.changes.map((c) => (
                            <span key={c.id} data-testid="settled-tag" className="meta" title={describe(c)} style={{ lineHeight: '14px', overflowWrap: 'anywhere' }}>
                              {settledNote(lane, c) ?? c.status}
                            </span>
                          ))
                        : cell.changes.map((c) => <ChangeButtons key={c.id} change={c} describe={describe(c)} disabled={busy} onAccept={accept} onRefuse={refuse} />)}
                      {cell.mark === 'modified' && cellOffSlide(cell.changes).length > 0 ? (
                        <span data-testid="modified-tag" className="meta" style={{ lineHeight: '14px' }}>
                          {cellOffSlide(cell.changes).join(', ')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {skipped.length > 0 ? (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, width: 'max-content' }}>
                {skipped.map((c) => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span className="muted">{describe(c)}: no longer applies on main</span>
                    <ChangeButtons change={c} describe={describe(c)} disabled={busy} onAccept={accept} onRefuse={refuse} />
                  </div>
                ))}
              </div>
            ) : null}
          </section>
          {cells.flatMap((cell) => (cell.dest ? [<MoveConnector key={`move:${cell.id}`} col={cell.col} boundary={cell.dest.boundary} />] : []))}
        </div>
        {remarksOpen && remarks.length > 0 ? (
          <div data-testid="lane-remarks" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 6px' }}>
            {remarks.map((r) => (
              <div key={r.id} style={{ width: 280 }}>
                <RemarkPostIt remark={r} onPropose={remarkApi.proposeRemark} onResolve={remarkApi.resolveRemark} expandable />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type Modify = Extract<Change, { kind: 'modify' }>;
const VARIANT_FIELDS: readonly (keyof SlidePatch)[] = ['title', 'story', 'notes', 'body', 'assets', 'kind'];

/** Lanes whose pending modify rewrites the same field of the same slide: the creator picks one. */
export interface VariantGroup {
  key: string;
  slide: SlideId;
  field: keyof SlidePatch;
  /** Oldest first. */
  members: { lane: LanePayload; change: Modify }[];
}

const pendingModifies = (lane: LanePayload): (Modify & { variantOf?: string[] })[] =>
  lane.changes.filter((c): c is Modify & LaneChange => c.kind === 'modify' && c.status === 'pending');
const patches = (c: Modify, f: keyof SlidePatch): boolean => c.patch[f] !== undefined;

/**
 * The variant groups among open lanes, from the server's `variantOf` on each pending modify: two lanes are variants
 * when one names the other and both have a pending modify writing the same field of the same slide (the first field
 * in slide order). A lane joins one group at most; groups of one are dropped.
 */
export function variantGroups(lanes: readonly LanePayload[]): VariantGroup[] {
  const byId = new Map(lanes.map((l) => [l.id, l] as const));
  const groups = new Map<string, VariantGroup>();
  const taken = new Set<string>();
  const join = (key: string, slide: SlideId, field: keyof SlidePatch, lane: LanePayload, change: Modify): void => {
    if (taken.has(lane.id)) return;
    const g = groups.get(key) ?? { key, slide, field, members: [] };
    g.members.push({ lane, change });
    groups.set(key, g);
    taken.add(lane.id);
  };
  for (const lane of [...lanes].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    for (const c of pendingModifies(lane)) {
      const others = (c.variantOf ?? []).flatMap((id) => {
        const o = byId.get(id);
        return o && o.status === 'open' ? pendingModifies(o).filter((x) => x.slide === c.slide).map((x) => ({ lane: o, change: x })) : [];
      });
      const field = VARIANT_FIELDS.find((f) => patches(c, f) && others.some((o) => patches(o.change, f)));
      if (!field) continue;
      const key = `${c.slide}:${field}`;
      join(key, c.slide, field, lane, c);
      for (const o of others) if (patches(o.change, field)) join(key, c.slide, field, o.lane, o.change);
    }
  }
  return [...groups.values()]
    .filter((g) => g.members.length > 1)
    .map((g) => ({ ...g, members: [...g.members].sort((a, b) => a.lane.createdAt.localeCompare(b.lane.createdAt)) }));
}

/** A variant's proposed value of the contested field, in words (body HTML as its text). */
export function variantText(change: Modify, field: keyof SlidePatch): string {
  const v = change.patch[field];
  if (Array.isArray(v)) return v.join(', ');
  const text = String(v ?? '');
  return field === 'body' ? text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : text;
}

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/** Grid columns each variant takes: its thumb and room for the proposed text beside the next one. */
const VARIANT_COLS = 2;

export interface VariantRowProps {
  group: VariantGroup;
  previews: Record<string, LanePreviewPayload | undefined>;
  mainOrder: SlideId[];
  mainThumbs: Record<SlideId, string | undefined>;
  api: LaneApi;
  failedThumbs?: ReadonlySet<string>;
  onOpenChange?(laneId: string, changeId: string): void;
}

/**
 * Competing lanes on one slide field as one row, "slide 2, title: 2 variants": the variants side by side from the
 * slide's column, each with its render, its lane name, the value it proposes, when it was proposed, and its own
 * accept and refuse. Accepting one leaves the others stale on the server, and they leave main.
 */
export function VariantRow({ group, previews, mainOrder, mainThumbs, api, failedThumbs = NO_FAILED, onOpenChange = openFocus }: VariantRowProps) {
  const col = mainOrder.indexOf(group.slide);
  const n = Math.max(mainOrder.length, 1);
  const span = group.members.length * VARIANT_COLS;
  return (
    <div id={`variant-row-${group.key}`} data-testid="variant-row" data-slide={group.slide} data-field={group.field} className="lane-row" style={{ display: 'flex', alignItems: 'stretch' }}>
      <div className="gutter" style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8 }}>
        <span className="row-label" data-testid="variant-label">
          slide {col + 1}, {group.field}: {group.members.length} variants
        </span>
        <span className="meta">accept one, the others close</span>
      </div>
      <div data-testid="lane-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, var(--thumb-w))`, gridAutoColumns: 'var(--thumb-w)', columnGap: 'var(--col-gap)', padding: '0 6px' }}>
        <section
          data-testid="variant-region"
          aria-label={`variants for slide ${col + 1}, ${group.field}`}
          style={{ gridColumn: `${col + 1} / span ${span}`, minWidth: 0, paddingTop: 6, display: 'grid', gridTemplateColumns: `repeat(${span}, var(--thumb-w))`, columnGap: 'var(--col-gap)' }}
        >
          {group.members.map((m, i) => (
            <VariantCell
              key={m.lane.id}
              lane={m.lane}
              change={m.change}
              field={group.field}
              col={col}
              gridColumn={`${i * VARIANT_COLS + 1} / span ${VARIANT_COLS}`}
              preview={previews[m.lane.id]}
              mainThumb={mainThumbs[group.slide]}
              api={api}
              failedThumbs={failedThumbs}
              onOpenChange={onOpenChange}
            />
          ))}
        </section>
      </div>
    </div>
  );
}

function VariantCell({
  lane,
  change,
  field,
  col,
  gridColumn,
  preview,
  mainThumb,
  api,
  failedThumbs,
  onOpenChange,
}: {
  lane: LanePayload;
  change: Modify;
  field: keyof SlidePatch;
  col: number;
  gridColumn: string;
  preview: LanePreviewPayload | undefined;
  mainThumb: string | undefined;
  api: LaneApi;
  failedThumbs: ReadonlySet<string>;
  onOpenChange(laneId: string, changeId: string): void;
}) {
  const { busy, error, accept, refuse } = useLaneActions(lane.id, api);
  const t = preview?.thumbs[change.slide];
  const url = t ? (failedThumbs.has(t.hash) ? FAILED_THUMB : t.ready ? thumbUrl(t.hash) : undefined) : mainThumb;
  const text = variantText(change, field);
  const title = preview?.slides[change.slide]?.title ?? text;
  return (
    <div data-testid="variant-cell" data-lane={lane.id} data-col={col} style={{ gridColumn, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Thumb slideId={change.slide} n={col + 1} title={title} url={url} selected={false} numbered={false} hoverTitle={false} onClick={() => onOpenChange(lane.id, change.id)} />
      <span className="meta" style={{ overflowWrap: 'anywhere' }}>
        {lane.label}
      </span>
      <span data-testid="variant-text" title={text} style={variantTextStyle}>
        {text}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ChangeButtons change={change} describe={`${field} of slide ${col + 1} to ${text}`} disabled={busy} onAccept={accept} onRefuse={refuse} />
        <span data-testid="variant-time" className="meta">
          {clock(lane.createdAt)}
        </span>
      </div>
      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const variantTextStyle: CSSProperties = {
  fontSize: 'var(--fs-body)',
  fontWeight: 500,
  lineHeight: 1.35,
  color: 'var(--ink)',
  overflowWrap: 'break-word',
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 3,
  overflow: 'hidden',
};

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
/** The moved slot's link: the card and the words under it, in the slot's own colours. */
const movedLink: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'stretch', color: 'inherit', textDecoration: 'none', cursor: 'pointer', borderRadius: 4 };

/** A slide's render in a 16:9 card, no control of its own (the moved slot's link holds it); a grey block until ready. */
function SlideCard({ url }: { url: string | undefined }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className="edge-frame" style={{ width: 'var(--thumb-w)', height: 'var(--thumb-h)', borderRadius: 4, overflow: 'hidden', background: 'var(--card)', boxShadow: '0 0 0 1px var(--line)', transition: 'box-shadow .15s ease' }}>
      {url !== undefined && !failed ? (
        <img data-testid="thumb-image" src={url} alt="" draggable={false} onError={() => setFailed(true)} style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }} />
      ) : (
        <div data-testid="thumb-placeholder" style={{ width: '100%', height: '100%', background: 'var(--line)' }} />
      )}
    </div>
  );
}

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
 * Where the row's move path (MoveConnector) starts: a dot on the top edge of the moved slide's card, which sits in its
 * old column with "moved to 24" and its title under it.
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

/** The accent dot on a modified card. A story or notes rewrite says which under the card, by its buttons. */
function ModifiedDot() {
  return (
    <div style={{ ...overlay, width: 7, height: 7, top: 4, left: 'calc(var(--thumb-w) - 11px)', display: 'flex' }}>
      <span data-testid="modified-dot" style={{ width: 7, height: 7, flex: '0 0 7px', borderRadius: 999, background: 'var(--accent)' }} />
    </div>
  );
}

/**
 * Where a lane's edge chip points when none of its changed slides is in view: the nearest changed column past the
 * visible end (right) or before the visible start (left). Null while one is in view, or without a view.
 */
export function edgeTarget(cells: readonly Cell[], view: { first: number; end: number } | undefined): { side: 'left' | 'right'; col: number } | null {
  if (!view) return null;
  const changed = cells.filter((c) => c.mark !== 'settled').map((c) => c.col);
  if (changed.length === 0 || changed.some((c) => c >= view.first && c < view.end)) return null;
  const after = changed.filter((c) => c >= view.end);
  if (after.length > 0) return { side: 'right', col: Math.min(...after) };
  return { side: 'left', col: Math.max(...changed.filter((c) => c < view.first)) };
}

/**
 * A moved slide's path inside its own lane row: an accent hairline along the row's top, from the dot on the moved
 * card's top edge (its old column) to the column boundary where it lands, ending on a short tick. It is a cell of the
 * row's own grid, so it never crosses main's strip or another row; nothing is drawn when the slide stays in place.
 */
export function MoveConnector({ col, boundary }: { col: number; boundary: number }) {
  if (boundary === col || boundary === col + 1) return null;
  const back = boundary < col;
  // Earlier: from the gap before column `boundary` to the moved card's dot; later: from the dot to the gap before `boundary`.
  const span = back ? `${boundary + 1} / ${col + 1}` : `${col + 1} / ${boundary + 1}`;
  const style: CSSProperties = {
    gridRow: '1',
    gridColumn: span,
    alignSelf: 'start',
    position: 'relative',
    zIndex: 1,
    height: 0,
    marginTop: 5,
    borderTop: '1px solid var(--accent)',
    pointerEvents: 'none',
    ...(back
      ? { marginLeft: 'calc(var(--col-gap) / -2)', marginRight: `calc(-1 * (var(--col-gap) + ${MOVE_X}px))` }
      : { marginLeft: MOVE_X, marginRight: 'calc(var(--col-gap) / -2)' }),
  };
  return (
    <span data-testid="move-path" data-from={col} data-to={boundary} aria-hidden style={style}>
      <span style={{ position: 'absolute', top: -1, [back ? 'left' : 'right']: -0.5, width: 1, height: 9, background: 'var(--accent)' }} />
    </span>
  );
}
