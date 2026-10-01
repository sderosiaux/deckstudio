import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { Anchor, Change, Lane, Slide, SlideId, ThreadKey, ThreadMessage } from '../../../src/model/types.js';
import {
  focusApi,
  focusPath,
  mainPath,
  navigate as defaultNavigate,
  slidePath,
  subscribe as defaultSubscribe,
  thumbUrl,
  type BusEvent,
  type DeckPayload,
  type FocusApi,
  type LanePreviewPayload,
  type ThumbStatus,
  mainHref,
} from '../api.js';
import { routeOf } from '../base.js';
import { EdgeFade, useVisibleColumns } from '../components/EdgeFade.js';
import { ALREADY_ON_MAIN, causesOf, settledNote } from '../components/ChangeButtons.js';
import { BackToMain, ScreenHeader } from '../components/ScreenHeader.js';
import { Filmstrip } from '../components/Filmstrip.js';
import { anchorColumns, offSlideFields, originTag, type OffSlideField } from '../components/LaneRow.js';
import { describeAnchor } from '../components/ContextChip.js';
import { Thumb } from '../components/Thumb.js';
import { SlidePreview, type SlidePreviewProps } from '../components/SlidePreview.js';
import { TextDiff, plainText } from '../components/TextDiff.js';
import { Thread, type ThreadNote } from '../components/Thread.js';
import { WIDE_QUERY, nameSlides, useMediaQuery } from './Slide.js';

export interface FocusProps {
  laneId: string;
  changeId: string;
  api?: FocusApi;
  /** Server events; returns the unsubscribe function. */
  subscribe?(handler: (e: BusEvent) => void): () => void;
  navigate?(path: string): void;
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; deck: DeckPayload; lane: Lane; preview: LanePreviewPayload };

const targetOf = (c: Change): SlideId => (c.kind === 'insert' ? c.slide.id : c.slide);
const pendingOf = (lane: Lane): Change[] => (lane.status === 'open' ? lane.changes.filter((c) => c.status === 'pending') : []);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Where to go once `changeId` is decided: the next pending change of the lane after it in lane order, else the first
 * one; with none left, the edit screen of the slide it changed when main still has it, else main.
 */
export function pathAfter(lane: Lane, changeId: string, slide: SlideId, mainOrder: readonly SlideId[]): string {
  const pending = pendingOf(lane).filter((c) => c.id !== changeId);
  if (pending.length === 0) return mainOrder.includes(slide) ? slidePath(slide) : mainHref();
  const pos = lane.changes.findIndex((c) => c.id === changeId);
  const next = pending.find((c) => lane.changes.indexOf(c) > pos) ?? pending[0]!;
  return focusPath(lane.id, next.id);
}

/** The title of accept and refuse while the co-author works on a turn of this lane's thread. */
export const REVISING = 'the co-author is revising this lane';

export type Outcome = 'accepted' | 'already on main' | 'refused' | 'stale' | 'discarded' | 'pending';

/** What became of a change: decided by the creator, settled by the server on a rebase, dropped with its lane, or still open. */
export function outcomeOf(lane: Lane, c: Change): { outcome: Outcome; reason: string | null } {
  const cause = causesOf(lane)[c.id] ?? null;
  if (c.status === 'orphan') return { outcome: 'stale', reason: cause ?? 'it no longer applies on main' };
  if (c.status === 'accepted') return cause === ALREADY_ON_MAIN ? { outcome: 'already on main', reason: null } : { outcome: 'accepted', reason: null };
  if (c.status === 'refused') return { outcome: 'refused', reason: null };
  return lane.status === 'open' ? { outcome: 'pending', reason: null } : { outcome: 'discarded', reason: null };
}

export type StripState = 'changed' | 'refused' | 'stale' | 'same';

/**
 * The lane's slides as numbers, for the strip under the diff: main's order with the lane's new slides placed after
 * their predecessor ("new"). A slide is `changed` when a change of the lane on it is pending or was accepted, `refused`
 * when its only decided changes were refused, `stale` when they no longer apply.
 */
export function stripCells(lane: Lane, mainOrder: readonly SlideId[]): { id: SlideId; label: string; state: StripState }[] {
  const ids: SlideId[] = [...mainOrder];
  const added = new Set<SlideId>();
  for (const c of lane.changes) {
    if (c.kind !== 'insert' || ids.includes(c.slide.id)) continue;
    const at = c.after === null ? 0 : ids.indexOf(c.after) + 1;
    ids.splice(c.after !== null && at === 0 ? ids.length : at, 0, c.slide.id);
    added.add(c.slide.id);
  }
  return ids.map((id) => {
    const on = lane.changes.filter((c) => targetOf(c) === id);
    const state: StripState = on.some((c) => c.status === 'pending' || c.status === 'accepted')
      ? 'changed'
      : on.some((c) => c.status === 'refused')
        ? 'refused'
        : on.some((c) => c.status === 'orphan')
          ? 'stale'
          : 'same';
    return { id, label: added.has(id) ? 'new' : String(mainOrder.indexOf(id) + 1), state };
  });
}

/** "from your request on slide 3", "unsolicited, from check: arc, on slides 2–4": where the lane comes from and what it is anchored on. */
export function originLine(lane: Lane, order: SlideId[], slides: Record<SlideId, Slide>): string {
  const on = describeAnchor(lane.anchor, order, slides);
  const tag = originTag(lane.origin);
  return tag ? `${tag}, on ${on}` : `from your request on ${on}`;
}

/**
 * Preview columns the lane covers: main's anchor slides still in the preview plus every slide the lane
 * inserts, modifies or moves, from the first to the last of them. Null when none is in the preview.
 */
export function laneColumns(lane: Lane, preview: LanePreviewPayload, mainOrder: SlideId[]): { start: number; span: number } | null {
  const cols = anchorColumns(lane.anchor, mainOrder);
  const ids = new Set(cols ? mainOrder.slice(cols.start, cols.start + cols.span) : []);
  const skipped = new Set(preview.skipped);
  for (const c of pendingOf(lane)) if (!skipped.has(c.id) && c.kind !== 'remove') ids.add(targetOf(c));
  const at = preview.order.map((id, i) => (ids.has(id) ? i : -1)).filter((i) => i >= 0);
  if (at.length === 0) return null;
  return { start: at[0]!, span: at[at.length - 1]! - at[0]! + 1 };
}

const TEXT_FIELDS = ['title', 'body', 'story', 'notes'] as const;

/** The fields a render cannot show: an insert brings them, a remove takes them away. */
const OFF_RENDER = ['story', 'notes'] as const;

/**
 * Text fields a change rewrites, each as before/after lines against main's slide: the fields a modify patches, the
 * story and notes an insert adds or a remove deletes (the render shows the rest). Empty fields and moves say nothing.
 */
export function textChanges(change: Change, before: Slide | undefined): { field: (typeof TEXT_FIELDS)[number]; before: string[]; after: string[] }[] {
  const lines = (field: (typeof TEXT_FIELDS)[number], v: string): string[] => (field === 'body' ? plainText(v) : v === '' ? [] : v.split('\n'));
  if (change.kind === 'insert') return OFF_RENDER.map((field) => ({ field, before: [], after: lines(field, change.slide[field]) })).filter((t) => t.after.length > 0);
  if (change.kind === 'remove') return before ? OFF_RENDER.map((field) => ({ field, before: lines(field, before[field]), after: [] })).filter((t) => t.before.length > 0) : [];
  if (change.kind !== 'modify' || !before) return [];
  return TEXT_FIELDS.flatMap((field) => {
    const next = change.patch[field];
    return next === undefined ? [] : [{ field, before: lines(field, before[field]), after: lines(field, next) }];
  });
}

/** The line above the pair of a modify the render cannot show: "only the story changes; the slide looks the same". */
export function sameRenderNote(fields: readonly OffSlideField[]): string | null {
  if (fields.length === 0) return null;
  const what = fields.length === 1 ? `the ${fields[0]} ${fields[0] === 'notes' ? 'change' : 'changes'}` : `the ${fields.join(' and ')} change`;
  return `only ${what}; the slide looks the same`;
}

/** The decision bar's height: a block of its own under the scrolling body, so it never sits over content. */
export const BAR_HEIGHT = 56;

/**
 * The exchange of a slide conversation that created `lane`: the turn (a user message and its replies up to the next
 * user message) during which the lane was created. A turn spans from its message to its last reply, the reply being
 * written after the tools ran; a turn with no timed reply runs until the next user message. No turn holds the
 * creation (a lane from a check, or one older than the conversation): nothing, never the latest unrelated exchange.
 */
export function creatingExchange(messages: readonly ThreadMessage[], lane: Pick<Lane, 'createdAt' | 'origin'>): ThreadMessage[] {
  const created = Date.parse(lane.createdAt);
  if (lane.origin !== 'user' || Number.isNaN(created)) return [];
  const turns: ThreadMessage[][] = [];
  for (const m of messages) {
    if (m.role === 'user') turns.push([m]);
    else turns.at(-1)?.push(m);
  }
  const found = turns.find(([ask, ...replies], i) => {
    const start = Date.parse(ask!.at);
    if (Number.isNaN(start) || created < start) return false;
    const times = replies.map((r) => Date.parse(r.at));
    if (times.length > 0 && times.every((t) => !Number.isNaN(t))) return created <= Math.max(...times);
    const next = turns[i + 1];
    return !next || created < Date.parse(next[0]!.at);
  });
  return found ?? [];
}

/** "14:32": the local time of `d`, 24-hour. */
export function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** What a change proposes, without its decision: a status change is no revision. */
const content = (c: Change): string => JSON.stringify({ ...c, status: null });

const navBtn: CSSProperties = { padding: '8px 0' };

/** Where main's slide at `mainAt` would sit in `laneOrder`, which no longer has it: after the nearest earlier slide the lane kept. */
export function gapIn(laneOrder: readonly SlideId[], mainOrder: readonly SlideId[], mainAt: number): number {
  for (let i = mainAt - 1; i >= 0; i--) {
    const at = laneOrder.indexOf(mainOrder[i]!);
    if (at >= 0) return at + 1;
  }
  return 0;
}

/** The accent line under the columns a strip's lane covers, named by a 12px grey line at its left end. */
function RangeUnderline({ count, cols, label }: { count: number; cols: { start: number; span: number } | null; label: string }) {
  if (!cols) return null;
  return (
    <div style={{ display: 'flex' }}>
      <div className="gutter" />
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(count, 1)}, var(--thumb-w))`, columnGap: 'var(--col-gap)', padding: '0 6px' }}>
        <div data-testid="range-underline" style={{ gridColumn: `${cols.start + 1} / span ${cols.span}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ height: 2, borderRadius: 1, background: 'var(--accent)' }} />
          <span data-testid="range-label" className="meta" style={{ lineHeight: '16px', whiteSpace: 'nowrap' }}>{label}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Where each slide of a move strip sits on its two-row grid (1-based CSS lines): the moved slide spans both rows, its
 * neighbours pair up in columns from it outwards, read top then bottom; a neighbour left without a pair, at a far
 * end, centres in its column. No paper above the small renders, whatever the strip's length.
 */
export function moveGrid(count: number, at: number): { column: number; row: string }[] {
  const before = at;
  const lead = Math.ceil(before / 2);
  return Array.from({ length: count }, (_, i) => {
    if (i === at) return { column: lead + 1, row: '1 / span 2' };
    if (i < at) {
      const d = at - 1 - i;
      const alone = before % 2 === 1 && i === 0;
      return { column: lead - Math.floor(d / 2), row: alone ? '1 / span 2' : d % 2 === 0 ? '2' : '1' };
    }
    const j = i - at - 1;
    const alone = j % 2 === 0 && i === count - 1;
    return { column: lead + 2 + Math.floor(j / 2), row: alone ? '1 / span 2' : String((j % 2) + 1) };
  });
}

/** What a structure strip centres on: a slide, twice its neighbours' size (struck when the lane removes it), or the gap a removed slide leaves. */
type StripFocus = { kind: 'slide'; id: SlideId; removed?: string } | { kind: 'gap'; at: number; label: string };

/**
 * A move or a remove as structure: one side's whole order as a strip of renders in two rows, centred on the slide the
 * change is about (twice its neighbours' size and ringed) or on the gap it leaves; the strip scrolls so that column
 * sits in its middle. The theme sizes the thumbs from the body's height; `size` says which strip is the larger.
 */
function StructureStrip({ side, size, caption, order, slides, focus, url }: { side: 'main' | 'lane'; size: 'large' | 'small'; caption: string; order: SlideId[]; slides: Record<SlideId, Slide>; focus: StripFocus; url(id: SlideId): string | undefined }) {
  const list = useRef<HTMLDivElement>(null);
  const at = focus.kind === 'gap' ? focus.at : order.indexOf(focus.id);
  const entries: (SlideId | null)[] = focus.kind === 'gap' ? [...order.slice(0, at), null, ...order.slice(at)] : order;
  const cells = moveGrid(entries.length, at);
  useLayoutEffect(() => {
    const box = list.current;
    if (!box) return;
    const centre = (): void => {
      const item = box.querySelectorAll<HTMLElement>('[role="listitem"]')[at];
      if (item) box.scrollLeft = Math.max(0, item.offsetLeft + item.offsetWidth / 2 - box.clientWidth / 2);
    };
    centre();
    if (typeof ResizeObserver !== 'function') return;
    // The thumbs follow the viewport: a resize moves the centred column, so it is centred again.
    const ro = new ResizeObserver(centre);
    ro.observe(box);
    return () => ro.disconnect();
  }, [at, entries.length]);
  return (
    <figure data-testid="move-strip" data-side={side} data-size={size} className="move-strip">
      <figcaption data-testid="move-caption" className="move-caption">
        {caption}
      </figcaption>
      <div ref={list} role="list" className="move-strip-list">
        {entries.map((id, i) => {
          const place = { gridColumn: String(cells[i]!.column), gridRow: cells[i]!.row };
          if (id === null) {
            return (
              <div role="listitem" key="gap" data-testid="move-gap" className="move-gap" style={place}>
                <span className="move-gap-line" aria-hidden />
                <span className="move-gap-label">{focus.kind === 'gap' ? focus.label : ''}</span>
              </div>
            );
          }
          const big = focus.kind === 'slide' && id === focus.id;
          const removed = big && focus.kind === 'slide' ? focus.removed : undefined;
          return (
            <div role="listitem" key={id} className="move-strip-item" data-moved={big ? 'true' : undefined} data-removed={removed ? 'true' : undefined} style={{ ['--move-k' as string]: big ? '2' : '1', ...place }}>
              <Thumb slideId={id} n={order.indexOf(id) + 1} title={slides[id]?.title ?? id} url={url(id)} selected={big} hoverTitle={false} onClick={() => undefined} />
              {removed ? (
                <span data-testid="removed-overlay" className="move-removed">
                  <span>{removed}</span>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </figure>
  );
}

/** Scrolls `strip` sideways so `el` sits in its middle, unless `el` already shows whole right of the sticky gutter. */
function bringIntoStrip(strip: HTMLElement, el: HTMLElement): void {
  const box = strip.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const gutter = strip.querySelector('.gutter')?.getBoundingClientRect().right ?? box.left;
  if (r.left >= Math.max(box.left, gutter) && r.right <= box.right) return;
  strip.scrollLeft += r.left + r.width / 2 - (box.left + box.width / 2);
}

/** A decision made here: what to say, where "next" goes, the header's status, and the pair as it was decided. */
type Ack = { changeId: string; text: string; next: string; nextLabel: string; status: string; pair: [SlidePreviewProps, SlidePreviewProps] | null };

/** One change of a lane at reading size: main's slide against the lane's, the reason, the lane's thread, accept or refuse. */
export function Focus({ laneId, changeId, api = focusApi, subscribe = defaultSubscribe, navigate = defaultNavigate }: FocusProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [mainThumbs, setMainThumbs] = useState<Record<SlideId, ThumbStatus>>({});
  // Content each main thumb was fetched for, so a reload only re-requests the thumbs of slides that changed.
  const thumbStamps = useRef<Record<SlideId, string>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // A decision says itself where it was made; the screen stays until the creator moves on.
  const [ack, setAck] = useState<Ack | null>(null);
  // When the co-author last revised each change in place, by change id: the header's "revised hh:mm".
  const [revised, setRevised] = useState<Record<string, string>>({});
  // Each change's content as last loaded, to tell a revision from a reload.
  const seen = useRef<Record<string, string>>({});
  // The slide conversation the lane came from: its last exchange opens the lane thread.
  const [seed, setSeed] = useState<ThreadMessage[]>([]);
  const wide = useMediaQuery(WIDE_QUERY);
  // Lines added to the lane thread by this screen (decisions); not stored.
  const [notes, setNotes] = useState<ThreadNote[]>([]);
  // A turn of this lane's thread is running: the co-author may rewrite the change on screen.
  const [revising, setRevising] = useState(false);
  // The full filmstrips, folded by default into one strip of numbers.
  const [expanded, setExpanded] = useState(false);
  // The diff pane runs on below its bottom edge.
  const [fade, setFade] = useState(false);
  const pane = useRef<HTMLElement>(null);
  const generation = useRef(0);
  const changeRef = useRef(changeId);
  changeRef.current = changeId;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // One WebSocket for the screen; the thread registers here instead of opening its own.
  const listeners = useRef(new Set<(e: BusEvent) => void>());
  const fanout = useCallback((h: (e: BusEvent) => void) => {
    listeners.current.add(h);
    return () => {
      listeners.current.delete(h);
    };
  }, []);

  const reload = useCallback(
    async (cause: 'load' | 'lane' = 'load') => {
      const gen = ++generation.current;
      try {
        const [deck, lane, preview] = await Promise.all([api.getDeck(), api.getLane(laneId), api.getLanePreview(laneId)]);
        if (gen !== generation.current) return;
        setLoad({ status: 'ready', deck, lane, preview });
        if (cause === 'lane') {
          const at = clock(new Date());
          const first = pendingOf(lane)[0];
          const current = lane.changes.find((c) => c.id === changeRef.current);
          if (!current && first) {
            // Revised in place: the change on screen was replaced. Follow the lane to its first pending change.
            setRevised((r) => ({ ...r, [first.id]: at }));
            navigateRef.current(focusPath(lane.id, first.id));
          } else if (current && current.status === 'pending' && seen.current[current.id] !== undefined && seen.current[current.id] !== content(current)) {
            setRevised((r) => ({ ...r, [current.id]: at }));
          }
        }
        seen.current = Object.fromEntries(lane.changes.map((c) => [c.id, content(c)]));
        const stamp = (id: SlideId): string => JSON.stringify(deck.slides[id] ?? null);
        const onMain = new Set(deck.order);
        thumbStamps.current = Object.fromEntries(Object.entries(thumbStamps.current).filter(([id]) => onMain.has(id)));
        setMainThumbs((prev) => (Object.keys(prev).every((id) => onMain.has(id)) ? prev : Object.fromEntries(Object.entries(prev).filter(([id]) => onMain.has(id)))));
        // The focused slide first, then the rest left to right: the server renders one thumb at a time.
        // Only slides never fetched, or whose content changed since: a stamp is recorded once its thumb is in,
        // so a fetch cut short by a newer reload is retried by that reload.
        const focused = lane.changes.find((c) => c.id === changeRef.current);
        const head = focused ? targetOf(focused) : null;
        const ids = head && deck.order.includes(head) ? [head, ...deck.order.filter((id) => id !== head)] : deck.order;
        for (const id of ids.filter((x) => thumbStamps.current[x] !== stamp(x))) {
          const t = await api.thumbFor(id);
          if (gen !== generation.current) return;
          thumbStamps.current[id] = stamp(id);
          setMainThumbs((prev) => ({ ...prev, [id]: t }));
        }
      } catch (err) {
        if (gen !== generation.current) return;
        setLoad({ status: 'error', message: message(err) });
      }
    },
    [api, laneId],
  );

  useEffect(() => {
    void reload();
    const own: ThreadKey = `lane:${laneId}`;
    return subscribe((e) => {
      for (const h of listeners.current) h(e);
      if ('thread' in e && e.thread === own) {
        if (e.type === 'tool.call' || e.type === 'assistant.delta') setRevising(true);
        else if (e.type === 'assistant.done' || e.type === 'agent.error') setRevising(false);
      }
      if (e.type === 'deck.changed') void reload();
      else if ((e.type === 'lane.updated' || e.type === 'lane.closed') && e.laneId === laneId) void reload('lane');
      else if (e.type === 'thumb.ready') {
        setMainThumbs((prev) => {
          const hit = Object.keys(prev).filter((id) => prev[id]!.hash === e.hash && !prev[id]!.ready);
          if (hit.length === 0) return prev;
          const next = { ...prev };
          for (const id of hit) next[id] = { hash: e.hash, ready: true };
          return next;
        });
        setLoad((prev) => {
          if (prev.status !== 'ready') return prev;
          const hit = Object.keys(prev.preview.thumbs).filter((id) => prev.preview.thumbs[id]!.hash === e.hash && !prev.preview.thumbs[id]!.ready);
          if (hit.length === 0) return prev;
          const thumbs = { ...prev.preview.thumbs };
          for (const id of hit) thumbs[id] = { hash: e.hash, ready: true };
          return { ...prev, preview: { ...prev.preview, thumbs } };
        });
      }
    });
  }, [reload, subscribe, laneId]);

  useEffect(() => setActionError(null), [changeId]);

  // The thread's calls, with a message sent on this lane marking the turn as running until its reply.
  const threadApi = useMemo<FocusApi>(
    () => ({
      ...api,
      postMessage: async (key, text, context) => {
        if (key === `lane:${laneId}`) setRevising(true);
        try {
          await api.postMessage(key, text, context);
        } catch (err) {
          setRevising(false);
          throw err;
        }
      },
    }),
    [api, laneId],
  );

  // The bottom fade over the diff pane while it runs on below.
  const measure = useCallback(() => {
    const el = pane.current;
    if (el) setFade(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }, []);
  useEffect(() => {
    measure();
    const el = pane.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  });

  // A lane asked for on a slide opens with the request that created it and its answer, from the slide's own conversation.
  const seedSlide = load.status === 'ready' && load.lane.anchor.kind === 'slide' ? load.lane.anchor.slide : null;
  const createdAt = load.status === 'ready' ? load.lane.createdAt : '';
  const laneOrigin = load.status === 'ready' ? load.lane.origin : 'user';
  useEffect(() => {
    const creation = { createdAt, origin: laneOrigin };
    setSeed([]);
    if (!seedSlide) return;
    let live = true;
    api.getThread(`slide:${seedSlide}`).then(
      (list) => live && setSeed(creatingExchange(list, creation)),
      // Without the slide conversation the lane thread still works: it opens on its own messages.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, seedSlide, createdAt, laneOrigin]);

  const strips = useRef<HTMLElement>(null);
  const visible = useVisibleColumns(strips, '[data-strip="main"] [data-testid="thumb"]', [load.status, expanded]);

  // Once per change: the lane strip shows the column where the change lands (a move's destination included).
  const ready = load.status === 'ready';
  const laneAtForScroll = ready ? (() => {
    const c = load.lane.changes.find((x) => x.id === changeId);
    return c ? load.preview.order.indexOf(targetOf(c)) : -1;
  })() : -1;
  useEffect(() => {
    const strip = strips.current;
    if (!strip || laneAtForScroll < 0) return;
    const row = strip.querySelectorAll('[role="list"]')[1];
    const el = row?.children[laneAtForScroll]?.querySelector<HTMLElement>('[data-testid="thumb"]');
    if (el) bringIntoStrip(strip, el);
  }, [changeId, ready, laneAtForScroll, expanded]);

  const go = (path: string) => (e?: MouseEvent) => {
    e?.preventDefault();
    navigate(path);
  };

  if (load.status === 'loading') return <div style={{ padding: 32 }} className="muted">Loading lane…</div>;
  if (load.status === 'error') {
    return (
      <div style={{ padding: 32 }}>
        <p style={{ color: 'var(--warn)', fontWeight: 700 }}>Could not load this lane.</p>
        <p className="muted mono">{load.message}</p>
        <button type="button" className="btn" onClick={() => void reload()}>Retry</button>{' '}
        <a href={mainHref()} onClick={go(mainHref())} className="link">back to main</a>
      </div>
    );
  }

  const { deck, lane, preview } = load;
  const pending = pendingOf(lane);
  const index = pending.findIndex((c) => c.id === changeId);
  // While its acknowledgement shows, the decided change stays on screen.
  const acked = ack && ack.changeId === changeId ? lane.changes.find((c) => c.id === changeId) : undefined;
  const change = index >= 0 ? pending[index]! : acked;
  const target = change ? targetOf(change) : null;

  const mainUrl = (id: SlideId): string | undefined => {
    const t = mainThumbs[id];
    return t?.ready ? thumbUrl(t.hash) : undefined;
  };
  // Changed slides render from the preview's own hash; the lane's untouched slides are main's.
  const laneUrl = (id: SlideId): string | undefined => {
    const t = preview.thumbs[id];
    if (t) return t.ready ? thumbUrl(t.hash) : undefined;
    return mainUrl(id);
  };
  const mainThumbUrls = Object.fromEntries(deck.order.map((id) => [id, mainUrl(id)]));
  const laneThumbUrls = Object.fromEntries(preview.order.map((id) => [id, laneUrl(id)]));

  const leave = (path: string): void => navigate(path);

  const n = pending.length;
  const prev = index > 0 ? focusPath(lane.id, pending[index - 1]!.id) : null;
  const next = index >= 0 && index < n - 1 ? focusPath(lane.id, pending[index + 1]!.id) : null;
  const firstPending = pending[0] ? focusPath(lane.id, pending[0].id) : null;

  const openSlide = (id: SlideId): void => {
    const c = pending.find((x) => targetOf(x) === id);
    if (c && c.id !== changeId) leave(focusPath(lane.id, c.id));
  };

  let left: SlidePreviewProps | null = null;
  let right: SlidePreviewProps | null = null;
  const skipped = change ? preview.skipped.includes(change.id) : false;
  const mainAt = target ? deck.order.indexOf(target) : -1;
  const laneAt = target ? preview.order.indexOf(target) : -1;
  // A move or a remove shows as structure: the slide among its neighbours on each side, not two identical renders.
  // Once decided, the pair says what became of it.
  const asMove = change?.kind === 'move' && !skipped && mainAt >= 0 && laneAt >= 0 && !acked;
  const asRemove = change?.kind === 'remove' && !skipped && mainAt >= 0 && laneAt < 0 && !acked;
  if (change && target) {
    left =
      change.kind === 'insert'
        ? { label: 'main', variant: 'missing', missingText: 'not in main' }
        : mainAt < 0
          ? { label: 'main', variant: 'missing', missingText: 'no longer in main' }
          : { label: `main, slide ${mainAt + 1}`, variant: 'main', title: deck.slides[target]?.title ?? target, url: mainUrl(target) };
    right = skipped
      ? { label: 'this lane', variant: 'missing', missingText: 'no longer applies on main' }
      : change.kind === 'remove' && mainAt >= 0
        ? // The slide it deletes, at the same size as main's, under a dashed note: never an empty box.
          { label: `this lane, slide ${mainAt + 1} removed`, variant: 'lane', title: deck.slides[target]?.title ?? target, url: mainUrl(target), overlay: 'removed in this lane' }
        : change.kind === 'remove' || laneAt < 0
        ? { label: 'this lane', variant: 'missing', missingText: 'removed' }
        : {
            label: `this lane, slide ${laneAt + 1}${change.kind === 'move' && mainAt >= 0 ? ` (was ${mainAt + 1})` : ''}`,
            variant: 'lane',
            title: preview.slides[target]?.title ?? target,
            url: laneUrl(target),
          };
  }

  const decide = async (verb: 'accept' | 'refuse'): Promise<void> => {
    if (!change || !target || acked) return;
    setBusy(true);
    setActionError(null);
    // The pair as decided: main's render before, and what became of the proposal.
    const before = left && right ? ([left, right] as const) : null;
    try {
      let text: string;
      let next: string;
      let status: string;
      let nextLabel: string;
      let pair: Ack['pair'] = null;
      const labelFor = (path: string, mainOrder: readonly SlideId[]): string =>
        routeOf(path).startsWith('/lane/') ? 'next change' : routeOf(path).startsWith('/slide/') ? `back to slide ${mainOrder.indexOf(target) + 1}` : 'back to main';
      if (verb === 'accept') {
        const res = await api.acceptChange(lane.id, change.id);
        text = `accepted into main as v${res.version.n}`;
        status = `accepted (v${res.version.n})`;
        next = pathAfter(res.lane, change.id, target, res.version.order);
        nextLabel = labelFor(next, res.version.order);
        const now = change.kind === 'remove' ? `removed from main in v${res.version.n}` : text.replace('accepted into', 'now in');
        if (before) pair = [{ ...before[0], label: mainAt >= 0 ? `before, slide ${mainAt + 1}` : 'before' }, before[1].variant === 'lane' ? { ...before[1], variant: 'main', label: now } : { ...before[1], label: `${before[1].label}, accepted` }];
      } else {
        const after = await api.refuseChange(lane.id, change.id);
        text = 'refused';
        status = 'refused';
        next = pathAfter(after, change.id, target, deck.order);
        nextLabel = labelFor(next, deck.order);
        if (before) pair = [{ ...before[0], label: `${before[0].label}, kept` }, before[1].variant === 'lane' ? { ...before[1], variant: 'main', label: change.kind === 'remove' ? 'refused removal' : 'refused proposal' } : { ...before[1], label: 'refused' }];
      }
      const at = new Date().toISOString();
      setNotes((n) => [...n, { id: `decision-${change.id}`, text, at }]);
      setAck({ changeId: change.id, text, next, nextLabel, status, pair });
    } catch (err) {
      setActionError(message(err));
    } finally {
      setBusy(false);
    }
  };

  // Once decided, the pair stays as it was decided, named for what it now is.
  if (acked && ack?.pair) [left, right] = ack.pair;

  // Only when main still has the slide: a skipped change has nothing to diff against.
  const texts = change && target && !skipped && !acked ? textChanges(change, deck.slides[target]) : [];

  const sameRender = change && !skipped && !acked ? sameRenderNote(offSlideFields(change)) : null;

  const context: Anchor = target && deck.order.includes(target) ? { kind: 'slide', slide: target } : lane.anchor;
  // The change in the address when nobody has to decide it: the server settled it (stale, or already on main).
  const asked = lane.changes.find((c) => c.id === changeId);
  const settled = !change && asked ? settledNote(lane, asked) : null;
  const allDecided = !change && n === 0;
  const step = acked && ack
    ? ack.status
    : change
      ? `change ${index + 1} of ${n}`
      : allDecided
        ? 'all changes decided'
        : settled
          ? asked && asked.status === 'orphan' ? 'stale' : ALREADY_ON_MAIN
          : asked
            ? asked.status
            : 'not in this lane';
  const revisedAt = change ? revised[change.id] : undefined;

  const thread = (
    <Thread
      threadKey={`lane:${lane.id}`}
      title="conversation about this lane"
      hint="Your message revises this lane: ask for another wording, another render, or to drop a change."
      context={context}
      order={deck.order}
      slides={deck.slides}
      api={threadApi}
      subscribe={fanout}
      navigate={navigate}
      layout={wide ? 'panel' : 'inline'}
      heading="section"
      // Narrow, the log may take the body's height less the thread's header and composer (theme: .focus-thread).
      logMaxHeight={wide ? undefined : 'var(--focus-log-max)'}
      notes={notes}
      proposalActions="none"
      seed={seed.length > 0 ? { label: 'from the slide conversation', messages: seed } : undefined}
    />
  );

  // Narrow, the thread follows the renders in the scrolling body: the bar brings its composer into view, caret in it.
  const toComposer = (): void => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="focus-scroll"] [aria-label="message"]');
    input?.scrollIntoView?.({ block: 'nearest' });
    input?.focus({ preventScroll: true });
  };

  const bar: CSSProperties = { flex: `0 0 ${BAR_HEIGHT}px`, height: BAR_HEIGHT, display: 'flex', alignItems: 'center', gap: 20, padding: '0 24px', background: 'var(--paper)', borderTop: '1px solid var(--line)' };

  // "slide 3, Hook" for a slide on main, the lane's title for one it adds.
  const describeTarget = (c: Change): string => {
    const id = targetOf(c);
    const at = deck.order.indexOf(id);
    const title = deck.slides[id]?.title ?? preview.slides[id]?.title ?? (c.kind === 'insert' ? c.slide.title : id);
    return at >= 0 ? `slide ${at + 1}, ${title}` : `new slide, ${title}`;
  };
  // Where the creator goes once nothing is left to decide: the slide of this change, else the lane's, when main has it.
  const backTo = [asked ? targetOf(asked) : null, lane.anchor.kind === 'slide' ? lane.anchor.slide : lane.anchor.kind === 'range' ? lane.anchor.from : null, ...lane.changes.map(targetOf)].find(
    (id): id is SlideId => !!id && deck.order.includes(id),
  );
  const cells = stripCells(lane, deck.order);

  const decided = (
    <div data-testid="focus-decided" style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start', paddingBottom: 24, maxWidth: 924 }}>
      <p className="row-label" style={{ margin: 0 }}>All changes decided</p>
      <ul data-testid="focus-outcomes" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {lane.changes.map((c, i) => {
          const { outcome, reason } = outcomeOf(lane, c);
          return (
            <li key={c.id} data-outcome={outcome} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 12, rowGap: 2, fontSize: 'var(--fs-body)' }}>
              <span className="meta">change {i + 1}</span>
              <span>
                {c.kind} {describeTarget(c)}
              </span>
              <span style={{ fontWeight: 500 }}>{outcome}</span>
              {reason ? <span className="meta">{reason}</span> : null}
            </li>
          );
        })}
      </ul>
      {backTo ? (
        <a href={slidePath(backTo)} onClick={go(slidePath(backTo))} className="btn-primary">
          back to slide {deck.order.indexOf(backTo) + 1}
        </a>
      ) : (
        <a href={mainPath(lane.anchor)} onClick={go(mainPath(lane.anchor))} className="btn-primary">
          back to main
        </a>
      )}
    </div>
  );

  const notOnScreen = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start', paddingBottom: 24 }}>
      <p style={{ margin: 0 }}>
        {settled ? `Nothing to decide on this change: ${settled}.` : asked ? `This change is ${asked.status}.` : 'This change is no longer part of this lane.'}
      </p>
      {firstPending ? (
        <a href={firstPending} onClick={go(firstPending)} className="btn-primary">Review the first pending change</a>
      ) : (
        <a href={mainPath(lane.anchor)} onClick={go(mainPath(lane.anchor))} className="btn-primary">back to main</a>
      )}
    </div>
  );

  const toggleStrip = (): void => setExpanded((x) => !x);

  // Every change of the lane, above its conversation: what each does and why, the one on screen marked, the pending
  // ones a click away (previous and next only step one at a time), the decided ones with their outcome.
  const changeList = (
    <section data-testid="focus-changes" aria-label="changes in this lane" className="focus-changes">
      <h2 className="row-label" style={{ margin: 0 }}>changes in this lane</h2>
      <ol className="focus-change-list">
        {lane.changes.map((c, i) => {
          const { outcome } = outcomeOf(lane, c);
          const current = c.id === changeId;
          const path = focusPath(lane.id, c.id);
          const what = `${c.kind} ${describeTarget(c)}`;
          return (
            <li key={c.id} data-change={c.id} data-outcome={outcome} aria-current={current ? 'true' : undefined} className="focus-change">
              <span className="focus-change-head">
                <span className="meta">{i + 1}</span>
                {outcome === 'pending' && !current ? (
                  <a href={path} onClick={go(path)} className="link focus-change-what">
                    {what}
                  </a>
                ) : (
                  <span className="focus-change-what">{what}</span>
                )}
                {outcome === 'pending' ? null : <span className="meta">{outcome}</span>}
              </span>
              <span className="focus-change-reason">{nameSlides(c.reason, deck.order, { ...preview.slides, ...deck.slides })}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );

  return (
    <div data-testid="focus-layout" className="focus-layout" data-columns={wide ? '2' : '1'}>
      <div data-testid="focus-work" className="focus-work">
        <ScreenHeader>
          <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <h1 data-testid="focus-title" className="screen-title" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
              {lane.label}
            </h1>
            <p style={{ margin: 0, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <span data-testid="focus-origin" className="meta">{originLine(lane, deck.order, deck.slides)}</span>
              <span data-testid="focus-crumb" className="meta" style={{ color: 'var(--ink)' }}>{step}</span>
              {settled ? (
                <span data-testid="focus-settled" className="meta" style={{ color: 'var(--ink)' }}>
                  {settled}
                </span>
              ) : null}
              {revisedAt ? (
                <span data-testid="focus-revised" className="tag">
                  revised {revisedAt}
                </span>
              ) : null}
            </p>
          </div>
          <BackToMain navigate={navigate} style={{ alignSelf: 'flex-start' }} />
        </ScreenHeader>
        {/* One left edge: the body starts on the title's column, 24px in; no empty gutter, the renders take that width. */}
        <div className="focus-pane">
          <main ref={pane} data-testid="focus-scroll" className="focus-scroll" onScroll={measure}>
            {!change ? (
              allDecided ? decided : notOnScreen
            ) : (
              <>
                {sameRender ? (
                  <p data-testid="focus-same-render" className="meta" style={{ margin: '0 0 -8px' }}>
                    {sameRender}
                  </p>
                ) : null}
                {asMove && target ? (
                  <div data-testid="focus-pair" className="focus-move" data-kind="move">
                    <StructureStrip side="main" size="small" caption={`main, was ${mainAt + 1}`} order={deck.order} slides={deck.slides} focus={{ kind: 'slide', id: target }} url={mainUrl} />
                    <StructureStrip side="lane" size="large" caption={`this lane, now ${laneAt + 1}`} order={preview.order} slides={preview.slides} focus={{ kind: 'slide', id: target }} url={laneUrl} />
                  </div>
                ) : asRemove && target ? (
                  // The question a remove asks is whether the deck still reads: main around the slide, the lane closing the gap.
                  <div data-testid="focus-pair" className="focus-move" data-kind="remove">
                    <StructureStrip side="main" size="large" caption={`main, slide ${mainAt + 1}`} order={deck.order} slides={deck.slides} focus={{ kind: 'slide', id: target, removed: 'removed in this lane' }} url={mainUrl} />
                    <StructureStrip side="lane" size="small" caption={`this lane, without slide ${mainAt + 1}`} order={preview.order} slides={preview.slides} focus={{ kind: 'gap', at: gapIn(preview.order, deck.order, mainAt), label: `${mainAt + 1} removed` }} url={laneUrl} />
                  </div>
                ) : (
                  <div data-testid="focus-pair" className="focus-pair" data-shape={left?.variant === 'missing' ? 'after' : right?.variant === 'missing' ? 'before' : 'both'}>
                    {left ? <SlidePreview {...left} /> : null}
                    {right ? <SlidePreview {...right} /> : null}
                  </div>
                )}
                <p data-testid="focus-reason" style={{ margin: 0, display: 'flex', gap: 12, alignItems: 'baseline', fontSize: 13, maxWidth: '80ch' }}>
                  <span className="meta">{change.kind}</span>
                  <span style={{ color: 'var(--grey)' }}>{nameSlides(change.reason, deck.order, { ...preview.slides, ...deck.slides })}</span>
                </p>
                {texts.length > 0 ? (
                  <div data-testid="focus-diffs" className="focus-diffs">
                    {texts.map((t) => (
                      <TextDiff key={t.field} label={t.field} before={t.before} after={t.after} />
                    ))}
                  </div>
                ) : null}
              </>
            )}
            {actionError ? (
              <p role="alert" style={{ margin: 0, color: 'var(--warn)', fontSize: 13 }}>
                {actionError}
              </p>
            ) : null}
            {wide ? null : (
              <section aria-label="lane thread" className="focus-thread">
                {thread}
              </section>
            )}
          </main>
          {fade ? <div data-testid="focus-fade" className="focus-fade" aria-hidden="true" /> : null}
        </div>
        {change && acked && ack ? (
          <div data-testid="decide-ack" role="status" style={bar}>
            <span style={{ fontWeight: 500 }}>{ack.text}</span>
            <button type="button" className="btn-primary" onClick={() => leave(ack.next)}>
              {ack.nextLabel}
            </button>
          </div>
        ) : change ? (
          <div data-testid="decide-bar" style={bar}>
            <button type="button" className="link" style={navBtn} disabled={!prev} onClick={() => prev && leave(prev)}>
              previous change
            </button>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn-primary" disabled={busy || revising} title={revising ? REVISING : undefined} onClick={() => void decide('accept')}>
                accept
              </button>
              <button type="button" className="btn" disabled={busy || revising} title={revising ? REVISING : undefined} onClick={() => void decide('refuse')}>
                refuse
              </button>
            </div>
            <button type="button" className="link" style={navBtn} disabled={!next} onClick={() => next && leave(next)}>
              next change
            </button>
            {wide ? null : (
              <button type="button" className="link" style={{ ...navBtn, marginLeft: 'auto' }} onClick={toComposer}>
                write to the co-author
              </button>
            )}
          </div>
        ) : null}
        <div
          data-testid="focus-strip"
          className="focus-strip"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          title={expanded ? 'hide the slide strips' : 'show main and this lane as slide strips'}
          onClick={toggleStrip}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            toggleStrip();
          }}
        >
          <span className="meta focus-strip-name">slides</span>
          <span className="focus-strip-cells">
            {cells.map((c) => (
              <span key={c.id} data-testid="strip-cell" className="strip-cell" data-slide={c.id} data-state={c.state} aria-current={c.id === target ? 'true' : undefined}>
                {c.label}
              </span>
            ))}
          </span>
          <span className="meta focus-strip-toggle">{expanded ? 'hide strips' : 'show strips'}</span>
        </div>
        {expanded ? (
          <div style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--line)' }}>
            <footer ref={strips} className="fit-columns" style={{ background: 'var(--paper)', overflow: 'auto', padding: '14px 24px 14px 24px' }}>
              <div style={{ width: 'max-content', minWidth: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <Filmstrip order={deck.order} slides={deck.slides} thumbs={mainThumbUrls} selected={target ?? undefined} onSelect={openSlide} label="main" />
                  <RangeUnderline count={deck.order.length} cols={anchorColumns(lane.anchor, deck.order)} label="this lane's slides on main" />
                </div>
                <div>
                  <Filmstrip order={preview.order} slides={preview.slides} thumbs={laneThumbUrls} selected={target ?? undefined} onSelect={openSlide} label="this lane" fullLabel={lane.label} />
                  <RangeUnderline count={preview.order.length} cols={laneColumns(lane, preview, deck.order)} label="changed in this lane" />
                </div>
              </div>
            </footer>
            <EdgeFade visible={visible} />
          </div>
        ) : null}
      </div>
      {wide ? (
        <section data-testid="focus-side" aria-label="lane thread" className="focus-side">
          {changeList}
          {thread}
        </section>
      ) : null}
    </div>
  );
}
