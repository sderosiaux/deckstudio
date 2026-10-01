import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type React from 'react';
import type { Anchor, Lane, Remark, SlideId, ThreadKey, ThreadMessage, Version } from '../../../src/model/types.js';
import {
  BRIEF_PATH,
  focusPath,
  getDeck,
  getLane,
  getLanePreview,
  getLanes,
  getRemarks,
  getVersions,
  laneApi,
  laneFromHash,
  navigate,
  openLane,
  openPlayer,
  playerHref,
  remarkApi,
  selectionFromSearch,
  slidePath,
  subscribe,
  threadApi,
  thumbFor,
  thumbUrl,
  type BusEvent,
  type DeckPayload,
  type LanePayload,
  type LanePreviewPayload,
} from '../api.js';
import { END_W, EdgeFade, useVisibleColumns, type VisibleColumns } from '../components/EdgeFade.js';
import { Filmstrip } from '../components/Filmstrip.js';
import { FAILED_THUMB, LaneRow, MoveRisers, VariantRow, anchorColumns, variantGroups, type VariantGroup } from '../components/LaneRow.js';
import { RemarkPostIt, anchorLabel } from '../components/Remark.js';
import { RemarkRow } from '../components/RemarkRow.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { Thread } from '../components/Thread.js';
import type { RemarkDot } from '../components/Thumb.js';
import { VersionLine } from '../components/VersionLine.js';
import { modified, typingIn } from '../keys.js';

/** Bus events arriving within this window are applied together (an accept emits deck.changed plus one lane.updated per rebased lane). */
export const COALESCE_MS = 100;

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; deck: DeckPayload; versions: Version[] };

interface Queued {
  deck: boolean;
  lanes: boolean;
  refresh: Set<string>;
  closed: Set<string>;
}
const emptyQueue = (): Queued => ({ deck: false, lanes: false, refresh: new Set(), closed: new Set() });
const byCreated = (a: Lane, b: Lane): number => a.createdAt.localeCompare(b.createdAt);
/** A lane with nothing left to decide (every change accepted, refused or stale) has no row on main. */
const hasPending = (l: Lane): boolean => l.changes.some((c) => c.status === 'pending');
/** Lane rows read newest first: the work just asked for sits right under the strip. */
const newestFirst = (a: Lane, b: Lane): number => b.createdAt.localeCompare(a.createdAt);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A "propose" sent from this screen, waiting for the co-author's lane. */
interface ProposeNote {
  remarkId: string;
  /** "slide 3", "slides 2–4", "the whole deck". */
  where: string;
  /** The remark's lane when it was proposed: a link to it only counts once that lane changes again. */
  priorLaneId: string | null;
  /** Lanes created or updated since the propose. */
  touched: ReadonlySet<string>;
}
const MAX_NOTES = 5;
/** The selection panel runs from its column to the visible right edge, never narrower than 5 columns nor wider than 9. */
const PANEL_MIN_COLS = 5;
const PANEL_MAX_COLS = 9;
/** Room kept between the panel's bottom and the canvas's visible bottom (the versions rail starts there). */
const PANEL_CLEAR = 16;
/** What lies above the panel besides the strip: the canvas's 8px top padding, the pin row (8px and its 10px gap), 2px of margin. */
const PANEL_TOP = 28;
/** The lane rows' grid starts 6px right of the gutter (their side padding). */
const ROW_PAD = 6;
/** sessionStorage key: whether the whole-deck bar is open (the default) or folded to its 40px rail. */
const WHOLE_DECK_KEY = 'deckstudio.wholeDeck';
const readWholeDeck = (): boolean => {
  try {
    return sessionStorage.getItem(WHOLE_DECK_KEY) !== 'closed';
  } catch {
    return true;
  }
};
/** The whole-deck bar's two fixed widths: the strip's columns never move when a slide is selected. */
const BAR_OPEN_W = 360;
const BAR_SHUT_W = 40;
/** Remark cards the panel lists before "N more remarks": the conversation stays the larger part of the panel. */
const PANEL_REMARKS = 3;
const SLIDE_HINT = 'Ask the co-author about this slide: a sharper title, a tighter story, a diagram. Its proposal shows here with accept and refuse.';
const RANGE_HINT = 'Ask the co-author about these slides. Only the messages sent on this range show here; the whole deck keeps its own conversation.';
const DECK_HINT = 'Ask the co-author about the whole deck: its arc, its order, its pacing. Select a slide to talk about it right under the strip.';

/** Focus route of the lane now linked to the note's remark, once the co-author's lane is there with something to review. */
export function noteHref(note: ProposeNote, remarks: readonly Remark[], lanes: readonly Lane[]): string | undefined {
  const laneId = remarks.find((r) => r.id === note.remarkId)?.laneId;
  if (!laneId || (laneId === note.priorLaneId && !note.touched.has(laneId))) return undefined;
  const lane = lanes.find((l) => l.id === laneId && l.status === 'open');
  const first = lane?.changes.find((c) => c.status === 'pending');
  return lane && first ? focusPath(lane.id, first.id) : undefined;
}

const WHOLE_DECK: Anchor = { kind: 'arc' };

/**
 * The whole-deck conversation without the turns about a slide or a range: a user message with such a context and the
 * replies up to the next user message belong to that selection's panel. A message with no context is the whole deck's.
 */
export function deckTurns(messages: readonly ThreadMessage[]): ThreadMessage[] {
  let scoped = false;
  return messages.filter((m) => {
    if (m.role === 'user') scoped = m.context !== null && m.context.kind !== 'arc';
    return !scoped;
  });
}

/** Width of the selection panel in columns, from its 0-based column: to the visible end, clamped to 5..9 (9 when its column is out of view). */
export function panelSpan(col: number, view: { first: number; end: number } | undefined): number {
  const toEdge = view && col >= view.first && col < view.end ? view.end - col : PANEL_MAX_COLS;
  return Math.min(PANEL_MAX_COLS, Math.max(PANEL_MIN_COLS, toEdge));
}

/** Scrolls `canvas` sideways so that main's column `col` (0-based) is the first one right of the gutter. */
export function revealColumn(canvas: HTMLElement, col: number): void {
  const thumb = canvas.querySelectorAll('[data-strip="main"] [data-testid="thumb"]')[col];
  if (!thumb) return;
  const edge = (canvas.querySelector('.gutter') ?? canvas).getBoundingClientRect().right + ROW_PAD;
  canvas.scrollLeft += thumb.getBoundingClientRect().left - edge;
}

/** Remark counts per main slide: a remark on a range counts on every slide of it; the colour is the worst severity. */
function remarkDots(remarks: readonly Remark[], order: SlideId[]): Record<SlideId, RemarkDot> {
  const dots: Record<SlideId, RemarkDot> = {};
  for (const r of remarks) {
    const cols = r.anchor.kind === 'arc' ? null : anchorColumns(r.anchor, order);
    if (!cols) continue;
    for (const id of order.slice(cols.start, cols.start + cols.span)) {
      const d = dots[id];
      dots[id] = { count: (d?.count ?? 0) + 1, severity: d?.severity === 'warn' || r.severity === 'warn' ? 'warn' : 'info' };
    }
  }
  return dots;
}

/**
 * The "+N" ends of main's strip as buttons that page it: on the left, the count of slides scrolled past (drawn here,
 * over the gutter's right end); on the right, a button over the count EdgeFade prints. Nothing while all fits.
 * Place it in the positioned box that holds the canvas; the canvas's 24px left padding is assumed.
 */
export function StripPager({ visible, onPage }: { visible: VisibleColumns | null; onPage(dir: -1 | 1): void }) {
  const row = visible?.rows[0];
  if (!visible || !row) return null;
  const box: CSSProperties = { position: 'absolute', top: row.top, width: END_W, height: 40, transform: 'translateY(-50%)' };
  return (
    <>
      {visible.first > 0 ? (
        <button
          type="button"
          className="strip-more"
          aria-label={`show the previous slides (${visible.first} more)`}
          title="Page back"
          onClick={() => onPage(-1)}
          style={{ ...box, left: `calc(24px + var(--gutter) - ${END_W}px)` }}
        >
          +{visible.first}
        </button>
      ) : null}
      {row.hidden > 0 ? (
        <button
          type="button"
          className="strip-more strip-more-over"
          aria-label={`show the next slides (${row.hidden} more)`}
          title="Page on"
          onClick={() => onPage(1)}
          style={{ ...box, left: visible.cut }}
        />
      ) : null}
    </>
  );
}

/**
 * The selection's remarks: the first three, then "N more remarks" that grows the list in place (never a scroll box
 * of its own, which cut cards and their actions). Remount it (key) to fold it again for another selection.
 */
function PanelRemarks({ remarks, card }: { remarks: readonly Remark[]; card(r: Remark): React.ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? remarks : remarks.slice(0, PANEL_REMARKS);
  const rest = remarks.length - PANEL_REMARKS;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div data-testid="panel-remarks" className="panel-remarks" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {shown.map((r) => (
          <div key={r.id} style={{ width: 280, maxWidth: '100%' }}>
            {card(r)}
          </div>
        ))}
      </div>
      {rest > 0 ? (
        <button type="button" className="link" aria-expanded={all} onClick={() => setAll((x) => !x)} style={{ alignSelf: 'flex-start', fontSize: 'var(--fs-meta)', color: 'var(--ink)' }}>
          {all ? 'show fewer' : `${rest} more ${rest === 1 ? 'remark' : 'remarks'}`}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The selection panel's box: it scrolls as a whole past its max height, and while more lies below its visible bottom
 * a fade says so. Measured after every render, on scroll, and when its content changes (messages arrive).
 */
function PanelBox({ style, children, ...rest }: React.HTMLAttributes<HTMLElement> & { 'data-testid': string; 'data-slide': string | undefined; 'data-kind': string }) {
  const box = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = box.current;
    if (el) setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 1);
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [measure]);
  return (
    <section ref={box} {...rest} data-overflow={more ? 'true' : undefined} style={style}>
      {children}
      {more ? <div data-testid="panel-fade" className="panel-fade" aria-hidden /> : null}
    </section>
  );
}

export function Main() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [thumbs, setThumbs] = useState<Record<SlideId, string | undefined>>({});
  const [failed, setFailed] = useState<ReadonlySet<SlideId>>(new Set());
  // hash -> slide, for thumb.ready events that do not carry a slideId.
  const pending = useRef(new Map<string, SlideId>());
  const generation = useRef(0);
  const mainOrder = useRef<SlideId[]>([]);
  // Content of each main slide as last shown, so a reload only re-requests the thumbs of slides that changed.
  const shownSlides = useRef<Record<SlideId, string>>({});
  const shownVersion = useRef<number | undefined>(undefined);
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;
  // Nothing selected means the whole deck: the context sent with a message is never null here.
  // `?select=` comes from "show" on the brief & checks screen; reload() drops it if the slide is gone.
  const [context, setContext] = useState<Anchor>(() => selectionFromSearch(location.search) ?? { kind: 'arc' });
  const scrollTo = useRef<SlideId | null>(context.kind === 'slide' ? context.slide : context.kind === 'range' ? context.from : null);
  const [remarks, setRemarks] = useState<Remark[]>([]);
  const [remarkError, setRemarkError] = useState<string | null>(null);
  const shift = useRef(false);
  // The last click on the strip came from a pointer (keyboard activation clicks with detail 0).
  const pointer = useRef(false);
  // The panel's composer takes the caret when a pointer opened it; never for a `?select=` on load or the keyboard.
  const [focusComposer, setFocusComposer] = useState(false);
  const [wholeDeck, setWholeDeckState] = useState(readWholeDeck);
  const setWholeDeck = useCallback((open: boolean) => {
    setWholeDeckState(open);
    try {
      sessionStorage.setItem(WHOLE_DECK_KEY, open ? 'open' : 'closed');
    } catch {
      // Storage refused (private mode): the choice holds for this page only.
    }
  }, []);
  const [lanes, setLanes] = useState<LanePayload[]>([]);
  // Lanes created or revised from a request here, latest first: they lead the lane rows. `flash` outlines one once.
  const [promoted, setPromoted] = useState<readonly string[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const revealLane = useRef<string | null>(null);
  // Threads with a request sent from the selection panel and no reply yet: a lane event meanwhile answers it.
  const asking = useRef(new Set<string>());
  const promote = useCallback((laneId: string) => {
    setPromoted((prev) => [laneId, ...prev.filter((id) => id !== laneId)]);
    setFlash(laneId);
    revealLane.current = laneId;
  }, []);
  // Lanes a check proposed that the creator has not opened: kept off main, reachable from their remark's post-it.
  const [drafts, setDrafts] = useState<ReadonlySet<string>>(new Set());
  const [notes, setNotes] = useState<ProposeNote[]>([]);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const [previews, setPreviews] = useState<Record<string, LanePreviewPayload>>({});
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  // Lane preview thumb hashes the server failed to render.
  const [failedLaneThumbs, setFailedLaneThumbs] = useState<ReadonlySet<string>>(new Set());
  const [laneError, setLaneError] = useState<string | null>(null);
  // The lane list itself could not be fetched: its error replaces the list (an empty state would claim "no lanes").
  const [lanesFailed, setLanesFailed] = useState<string | null>(null);
  // `/#lane=<id>` (a lane just opened from the history): scroll that row into view once it is on screen.
  const scrollLane = useRef<string | null>(laneFromHash(location.hash));
  // Latest request per lane (preview, and lane metadata), so a slow response never overwrites a newer one
  // or resurrects a closed lane. `laneEpoch` does the same for the full list.
  const laneGen = useRef(new Map<string, number>());
  const laneMetaGen = useRef(new Map<string, number>());
  const laneEpoch = useRef(0);
  const queued = useRef<Queued>(emptyQueue());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One WebSocket for the screen; children (the thread) register here instead of opening their own.
  const listeners = useRef(new Set<(e: BusEvent) => void>());
  const fanout = useCallback((h: (e: BusEvent) => void) => {
    listeners.current.add(h);
    return () => {
      listeners.current.delete(h);
    };
  }, []);

  const bump = (m: Map<string, number>, id: string): number => {
    const g = (m.get(id) ?? 0) + 1;
    m.set(id, g);
    return g;
  };

  const refreshPreview = useCallback(async (laneId: string) => {
    const gen = bump(laneGen.current, laneId);
    // Fetching the preview re-enqueues its thumbnails: failed ones get another try.
    const old = previewsRef.current[laneId];
    if (old) {
      const hashes = new Set(Object.values(old.thumbs).map((t) => t.hash));
      setFailedLaneThumbs((prev) => ([...prev].some((h) => hashes.has(h)) ? new Set([...prev].filter((h) => !hashes.has(h))) : prev));
    }
    try {
      const p = await getLanePreview(laneId);
      if (laneGen.current.get(laneId) !== gen) return;
      setPreviews((prev) => ({ ...prev, [laneId]: p }));
    } catch (err) {
      if (laneGen.current.get(laneId) !== gen) return;
      setLaneError(errText(err));
    }
  }, []);

  const dropLane = useCallback((laneId: string) => {
    bump(laneGen.current, laneId);
    bump(laneMetaGen.current, laneId);
    setLanes((prev) => prev.filter((l) => l.id !== laneId));
    setPreviews((prev) => {
      if (!(laneId in prev)) return prev;
      const { [laneId]: _gone, ...rest } = prev;
      return rest;
    });
  }, []);

  /** One lane changed (or appeared): fetch it and its preview, nothing else. */
  const refreshLane = useCallback(
    async (laneId: string) => {
      const gen = bump(laneMetaGen.current, laneId);
      const epoch = laneEpoch.current;
      try {
        const lane = await getLane(laneId);
        if (laneMetaGen.current.get(laneId) !== gen || laneEpoch.current !== epoch) return;
        setDrafts((prev) => {
          if (prev.has(laneId) === (lane.status === 'draft')) return prev;
          const next = new Set(prev);
          if (lane.status === 'draft') next.add(laneId);
          else next.delete(laneId);
          return next;
        });
        if (lane.status !== 'open') {
          dropLane(laneId);
          return;
        }
        setLanes((prev) => [...prev.filter((l) => l.id !== laneId), lane].sort(byCreated));
        setLaneError(null);
        await refreshPreview(laneId);
      } catch (err) {
        if (laneMetaGen.current.get(laneId) !== gen) return;
        setLaneError(errText(err));
      }
    },
    [dropLane, refreshPreview],
  );

  const reloadLanes = useCallback(async () => {
    const epoch = ++laneEpoch.current;
    try {
      const [listed, draft] = await Promise.all([getLanes(), getLanes('draft')]);
      if (laneEpoch.current !== epoch) return;
      const open = listed.filter((l) => l.status === 'open').sort(byCreated);
      setLanes(open);
      setDrafts(new Set(draft.map((l) => l.id)));
      setLaneError(null);
      setLanesFailed(null);
      const ids = new Set(open.map((l) => l.id));
      setPreviews((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))));
      await Promise.all(open.map((l) => refreshPreview(l.id)));
    } catch (err) {
      if (laneEpoch.current !== epoch) return;
      setLanesFailed(errText(err));
    }
  }, [refreshPreview]);

  const reloadRemarks = useCallback(async () => {
    try {
      // All of them: a propose note follows its remark's lane link even once the remark is resolved.
      setRemarks(await getRemarks());
      setRemarkError(null);
    } catch (err) {
      setRemarkError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshThumb = useCallback(async (id: SlideId, gen: number) => {
    const t = await thumbFor(id);
    if (gen !== generation.current) return;
    setFailed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (t.ready) {
      pending.current.delete(t.hash);
      setThumbs((prev) => ({ ...prev, [id]: thumbUrl(t.hash) }));
    } else {
      pending.current.set(t.hash, id);
    }
  }, []);

  const reload = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const [deck, versions] = await Promise.all([getDeck(), getVersions()]);
      if (gen !== generation.current) return;
      const stamp = (id: SlideId): string => JSON.stringify(deck.slides[id] ?? null);
      const before = shownSlides.current;
      const awaited = new Set(pending.current.values());
      // New or changed slides, plus any whose thumb never arrived and is not on its way (e.g. a request
      // dropped by an earlier, superseded reload). The others keep their URL.
      const stale = deck.order.filter((id) => before[id] !== stamp(id) || (thumbsRef.current[id] === undefined && !awaited.has(id)));
      const staleSet = new Set(stale);
      const onMain = new Set(deck.order);
      for (const [hash, id] of pending.current) if (!onMain.has(id) || staleSet.has(id)) pending.current.delete(hash);
      shownSlides.current = Object.fromEntries(deck.order.map((id) => [id, stamp(id)]));
      shownVersion.current = deck.state.version;
      mainOrder.current = deck.order;
      setContext((c) => (anchorColumns(c, deck.order) ? c : { kind: 'arc' }));
      setLoad({ status: 'ready', deck, versions });
      setThumbs((prev) => Object.fromEntries(deck.order.map((id) => [id, prev[id]])));
      setFailed((prev) => ([...prev].every((id) => onMain.has(id)) ? prev : new Set([...prev].filter((id) => onMain.has(id)))));
      // Sequential on purpose: the server renders one thumb at a time, so asking in deck order
      // makes thumbs appear left to right.
      for (const id of stale) {
        if (gen !== generation.current) return;
        await refreshThumb(id, gen);
      }
    } catch (err) {
      if (gen !== generation.current) return;
      setLoad({ status: 'error', message: errText(err) });
    }
  }, [refreshThumb]);

  /** The one reload path behind every Retry: deck, lanes and remarks together. */
  const reloadAll = useCallback(() => {
    void reload();
    void reloadLanes();
    void reloadRemarks();
  }, [reload, reloadLanes, reloadRemarks]);

  const flush = useCallback(() => {
    timer.current = null;
    const q = queued.current;
    queued.current = emptyQueue();
    if (q.deck) void reload();
    // A deck change rebases every open lane: the full list covers the per-lane events of the burst.
    if (q.lanes) {
      void reloadLanes();
      return;
    }
    for (const id of q.closed) dropLane(id);
    for (const id of q.refresh) if (!q.closed.has(id)) void refreshLane(id);
  }, [reload, reloadLanes, dropLane, refreshLane]);

  const schedule = useCallback(
    (update: (q: Queued) => void) => {
      update(queued.current);
      timer.current ??= setTimeout(flush, COALESCE_MS);
    },
    [flush],
  );

  useEffect(() => {
    reloadAll();
    // The selection is now in state; a later reload should not re-apply a stale query.
    if (location.search) history.replaceState(null, '', location.pathname);
    let opens = 0;
    const onEvent = (e: BusEvent): void => {
      for (const h of listeners.current) h(e);
      if (e.type === 'hello') {
        // Events sent while the socket was down are lost: resync after a reconnect, or when the server
        // reports a version other than the one on screen.
        const reconnect = e.version === null && ++opens > 1;
        const drifted = e.version !== null && shownVersion.current !== undefined && e.version !== shownVersion.current;
        if (reconnect || drifted) {
          schedule((q) => {
            q.deck = true;
            q.lanes = true;
          });
        }
      } else if (e.type === 'deck.changed') {
        schedule((q) => {
          q.deck = true;
          q.lanes = true;
        });
        void reloadRemarks();
      } else if (e.type === 'remarks.changed') {
        void reloadRemarks();
      } else if (e.type === 'assistant.done' || e.type === 'agent.error') {
        asking.current.delete(e.thread);
      } else if (e.type === 'lane.created' || e.type === 'lane.updated') {
        schedule((q) => q.refresh.add(e.laneId));
        // The answer to a request from the panel (or a lane appearing for a propose): first among the lanes, flashed.
        const proposing = e.type === 'lane.created' && notesRef.current.length > 0;
        if (asking.current.size > 0 || proposing) promote(e.laneId);
        // A lane answering a propose from here is linked to its remark (remark.laneId): look for the link.
        if (notesRef.current.length > 0) {
          setNotes((prev) => prev.map((n) => (n.touched.has(e.laneId) ? n : { ...n, touched: new Set(n.touched).add(e.laneId) })));
          void reloadRemarks();
        }
      } else if (e.type === 'lane.closed') {
        schedule((q) => q.closed.add(e.laneId));
        setDrafts((prev) => {
          if (!prev.has(e.laneId)) return prev;
          const next = new Set(prev);
          next.delete(e.laneId);
          return next;
        });
      } else if (e.type === 'thumb.ready') {
        setFailedLaneThumbs((prev) => {
          if (!prev.has(e.hash)) return prev;
          const next = new Set(prev);
          next.delete(e.hash);
          return next;
        });
        // Lane preview thumbs carry the preview slide id, which may also be a main id with other content: match by hash first.
        setPreviews((prev) => {
          let hit = false;
          const next: Record<string, LanePreviewPayload> = {};
          for (const [laneId, p] of Object.entries(prev)) {
            const ids = Object.keys(p.thumbs).filter((sid) => p.thumbs[sid]!.hash === e.hash && !p.thumbs[sid]!.ready);
            if (ids.length === 0) {
              next[laneId] = p;
              continue;
            }
            hit = true;
            const thumbs = { ...p.thumbs };
            for (const sid of ids) thumbs[sid] = { hash: e.hash, ready: true };
            next[laneId] = { ...p, thumbs };
          }
          return hit ? next : prev;
        });
        const id = pending.current.get(e.hash) ?? (e.slideId && mainOrder.current.includes(e.slideId) ? e.slideId : undefined);
        if (id) refreshThumb(id, generation.current).catch((err: unknown) => console.warn('deckstudio: thumb refresh failed', err));
      } else if (e.type === 'thumb.failed') {
        // Same hash-first matching as thumb.ready: a lane preview slide id may also be a main id.
        const laneHit = Object.values(previewsRef.current).some((p) => Object.values(p.thumbs).some((t) => t.hash === e.hash));
        if (laneHit) setFailedLaneThumbs((prev) => (prev.has(e.hash) ? prev : new Set(prev).add(e.hash)));
        const id = pending.current.get(e.hash) ?? (!laneHit && e.slideId && mainOrder.current.includes(e.slideId) ? e.slideId : undefined);
        console.warn(`deckstudio: thumbnail render failed for ${id ?? e.slideId ?? e.hash}: ${e.message}`);
        if (!id) return;
        pending.current.delete(e.hash);
        setFailed((prev) => new Set(prev).add(id));
      }
    };
    const off = subscribe(onEvent);
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      queued.current = emptyQueue();
    };
  }, [reloadAll, reloadRemarks, refreshThumb, schedule, promote]);

  const canvas = useRef<HTMLElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  const deckLength = load.status === 'ready' ? load.deck.order.length : 0;
  // Columns of main in sight: the strip ends on a fade and a count, and no remark card runs past the edge.
  const visible = useVisibleColumns(canvas, '[data-strip="main"] [data-testid="thumb"]', [load.status, deckLength, lanes.length]);
  const view = visible ? { first: visible.first, end: visible.end } : undefined;
  // The canvas opens at its origin (main's first slide, top left); only a `?select=` or `#lane=` moves it, and only
  // by the least that brings its target into view.
  useLayoutEffect(() => {
    if (load.status !== 'ready') return;
    const el = canvas.current;
    const id = scrollTo.current;
    scrollTo.current = null;
    if (!id && !scrollLane.current) el?.scrollTo?.(0, 0);
    if (id) document.querySelector(`[data-testid="thumb"][data-slide="${CSS.escape(id)}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [load.status]);

  useEffect(() => {
    const id = scrollLane.current;
    if (!id || !lanes.some((l) => l.id === id)) return;
    scrollLane.current = null;
    document.getElementById(`lane-row-${id}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    // Done with the hash: a reload of main should not jump back to that lane.
    history.replaceState(null, '', location.pathname + location.search);
  }, [lanes]);

  // A promoted lane scrolls into view once its row is on screen (its scroll-margin clears the sticky strip), unless the
  // selection panel is open: the answer shows there, under the reply, and the row below only mirrors it (flashed).
  useEffect(() => {
    const id = revealLane.current;
    if (!id || !lanes.some((l) => l.id === id)) return;
    revealLane.current = null;
    if (contextRef.current.kind !== 'arc') return;
    // Vertically only: the strip stays on the columns the creator was looking at.
    const left = canvas.current?.scrollLeft ?? 0;
    document.getElementById(`lane-row-${id}`)?.scrollIntoView?.({ block: 'nearest' });
    if (canvas.current) canvas.current.scrollLeft = left;
  }, [lanes, promoted]);

  // The panel's threads tell the screen when a request leaves; the whole-deck bar reads only whole-deck turns.
  const panelApi = useMemo(
    () => ({
      ...threadApi,
      postMessage: async (key: ThreadKey, text: string, ctx: Anchor | null): Promise<void> => {
        asking.current.add(key);
        try {
          await threadApi.postMessage(key, text, ctx);
        } catch (err) {
          asking.current.delete(key);
          throw err;
        }
      },
    }),
    [],
  );
  const deckApi = useMemo(() => ({ ...threadApi, getThread: async (key: ThreadKey) => deckTurns(await threadApi.getThread(key)) }), []);

  const select = useCallback((id: SlideId) => {
    const extend = shift.current;
    setContext((c) => {
      if (extend && c.kind !== 'arc') {
        const from = c.kind === 'slide' ? c.slide : c.from;
        const order = mainOrder.current;
        if (from === id) return { kind: 'slide', slide: id };
        const [a, b] = order.indexOf(from) <= order.indexOf(id) ? [from, id] : [id, from];
        return { kind: 'range', from: a, to: b };
      }
      return { kind: 'slide', slide: id };
    });
  }, []);

  // One slide selected: Enter or e opens its edit screen, unless the key is meant for a text field or a control.
  useEffect(() => {
    if (context.kind !== 'slide') return;
    const id = context.slide;
    const onKey = (e: KeyboardEvent): void => {
      // Enter in the panel's empty composer: nothing to send, so it opens the slide (click a thumb, then Enter).
      const t = e.target;
      const emptyComposer = e.key === 'Enter' && t instanceof HTMLInputElement && t.value === '' && t.closest('[data-testid="selection-panel"]') !== null;
      if (e.defaultPrevented || modified(e) || (typingIn(e.target) && !emptyComposer)) return;
      if (e.key !== 'Enter' && e.key !== 'e') return;
      if (e.key === 'Enter' && e.target instanceof Element && e.target.closest('button, a') && !e.target.closest('[data-testid="thumb"]')) return;
      e.preventDefault();
      navigate(slidePath(id));
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [context]);

  // Escape clears the selection; Home and End take the canvas to the start and the end of the strip. Never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || modified(e)) return;
      // In the panel's composer, Escape closes the panel once nothing is written.
      const t = e.target;
      if (e.key === 'Escape' && t instanceof HTMLInputElement && t.value === '' && t.closest('[data-testid="selection-panel"]')) {
        setContext({ kind: 'arc' });
        return;
      }
      if (typingIn(e.target)) return;
      if (e.key === 'Escape') {
        setContext((c) => (c.kind === 'arc' ? c : { kind: 'arc' }));
        return;
      }
      const el = canvas.current;
      if (!el || (e.key !== 'Home' && e.key !== 'End')) return;
      e.preventDefault();
      el.scrollLeft = e.key === 'End' ? el.scrollWidth : 0;
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // A plain mouse has one wheel: shift+wheel scrolls the strip sideways (a horizontal wheel or trackpad does natively).
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (!e.shiftKey || e.deltaX !== 0 || e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [load.status]);

  // The versions rail is pinned under the canvas, outside it: the canvas ends on a blank as tall as the rail, so the
  // last lane row scrolls well clear of the rail's edge.
  const rail = useRef<HTMLDivElement>(null);
  const [railHeight, setRailHeight] = useState(0);
  useLayoutEffect(() => {
    const el = rail.current;
    if (!el) return;
    const measure = (): void => setRailHeight(el.offsetHeight);
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [load.status]);

  // The strip header stays on top of the canvas: the selection panel never grows past the space left under it, so its
  // composer stays above the versions rail; the log scrolls inside.
  const stripHeader = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<{ canvas: number; strip: number }>({ canvas: 0, strip: 0 });
  useLayoutEffect(() => {
    const el = canvas.current;
    const head = stripHeader.current;
    if (!el || !head) return;
    const measure = (): void => setRoom((prev) => (prev.canvas === el.clientHeight && prev.strip === head.offsetHeight ? prev : { canvas: el.clientHeight, strip: head.offsetHeight }));
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    ro?.observe(head);
    return () => ro?.disconnect();
  }, [load.status]);

  // Clicking empty space (not a thumb, not a button) clears the selection back to the whole deck.
  const clearOnEmpty = (e: MouseEvent<HTMLElement>): void => {
    if (e.target instanceof Element && e.target.closest('button, a, input, textarea, [data-testid="thumb"], [data-testid="post-it"], [data-testid="selection-panel"], [data-testid="panel-bar"]')) return;
    setContext({ kind: 'arc' });
  };

  if (load.status === 'loading') return <div style={{ padding: 32 }} className="muted">Loading deck…</div>;
  if (load.status === 'error') {
    return (
      <div style={{ padding: 32 }}>
        <p style={{ color: 'var(--warn)', fontWeight: 700 }}>Could not load the deck.</p>
        <p className="muted mono">{load.message}</p>
        <button type="button" className="btn" onClick={reloadAll}>Retry</button>
      </div>
    );
  }

  const { deck, versions } = load;
  const shownThumbs = failed.size === 0 ? thumbs : Object.fromEntries(deck.order.map((id) => [id, failed.has(id) ? FAILED_THUMB : thumbs[id]]));
  const selectedCols = context.kind === 'arc' ? null : anchorColumns(context, deck.order);
  // Remarks on main are count dots on their slides; the selected slides' own remarks open in the panel.
  // Remarks from a lane-scoped check describe that lane's preview, not main: they stay with the lane row.
  const openRemarks = remarks.filter((r) => r.status === 'open');
  const mainRemarks = openRemarks.filter((r) => !r.sourceLaneId);
  const dots = remarkDots(mainRemarks, deck.order);
  const propose = async (id: string): Promise<void> => {
    const r = remarks.find((x) => x.id === id);
    await remarkApi.proposeRemark(id);
    const where = !r || r.anchor.kind === 'arc' ? 'the whole deck' : anchorLabel(r.anchor, deck.order);
    const note: ProposeNote = { remarkId: id, where, priorLaneId: r?.laneId ?? null, touched: new Set() };
    setNotes((prev) => [...prev.filter((n) => n.remarkId !== id), note].slice(-MAX_NOTES));
  };
  const trackedRemarkApi = { proposeRemark: propose, resolveRemark: remarkApi.resolveRemark };
  const draftOf = (r: Remark): string | undefined => (r.laneId && drafts.has(r.laneId) ? r.laneId : undefined);
  // The remark's lane is open on main (opened from its card, or proposed from it): the card names it, linked to its row.
  // A lane's place on main: its own row, or the variant row it competes in.
  const showLane = (laneId: string): void => {
    const row =
      document.getElementById(`lane-row-${laneId}`) ??
      document.querySelector(`[data-testid="variant-cell"][data-lane="${CSS.escape(laneId)}"]`)?.closest('[data-testid="variant-row"]');
    row?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };
  const openedLane = (r: Remark): { label: string; onShow(): void } | undefined => {
    const lane = r.laneId ? lanes.find((l) => l.id === r.laneId) : undefined;
    if (!lane) return undefined;
    return { label: lane.label, onShow: () => showLane(lane.id) };
  };
  // Remarks touching the selection: warnings first, then those on exactly the selection, then by where they start.
  const touches = (remark: Remark): { start: number; span: number } | null => {
    const cols = remark.anchor.kind === 'arc' ? null : anchorColumns(remark.anchor, deck.order);
    if (!cols || !selectedCols) return null;
    return cols.start < selectedCols.start + selectedCols.span && selectedCols.start < cols.start + cols.span ? cols : null;
  };
  const exact = (c: { start: number; span: number }): boolean => !!selectedCols && c.start === selectedCols.start && c.span === selectedCols.span;
  const panelRemarks = mainRemarks
    .flatMap((r) => {
      const cols = touches(r);
      return cols ? [{ r, cols }] : [];
    })
    .sort(
      (a, b) =>
        Number(b.r.severity === 'warn') - Number(a.r.severity === 'warn') ||
        Number(exact(b.cols)) - Number(exact(a.cols)) ||
        a.cols.start - b.cols.start,
    )
    .map((x) => x.r);
  const shownLanes = lanes.filter(hasPending).sort((a, b) => {
    const rank = (l: Lane): number => {
      const i = promoted.indexOf(l.id);
      return i < 0 ? promoted.length : i;
    };
    return rank(a) - rank(b) || newestFirst(a, b);
  });
  const openFromRemark = (laneId: string): Promise<void> => {
    promote(laneId);
    return openLane(laneId);
  };
  const page = (dir: -1 | 1): void => {
    const el = canvas.current;
    if (!el || !visible) return;
    const per = Math.max(1, visible.end - visible.first);
    revealColumn(el, dir > 0 ? Math.min(deck.order.length - 1, visible.end) : Math.max(0, visible.first - per));
  };
  const reveal = (col: number): void => {
    if (canvas.current) revealColumn(canvas.current, col);
  };
  // Lanes competing on one slide field share one row, placed where the first of them would sit; a lane with other
  // pending changes keeps its own row too.
  const groups = variantGroups(shownLanes).filter((g) => deck.order.includes(g.slide));
  const groupOf = new Map<string, VariantGroup>(groups.flatMap((g) => g.members.map((m) => [m.lane.id, g] as const)));
  const placedGroups = new Set<string>();
  const laneRows = shownLanes.flatMap((l): React.ReactNode[] => {
    const g = groupOf.get(l.id);
    const out: React.ReactNode[] = [];
    if (g && !placedGroups.has(g.key)) {
      placedGroups.add(g.key);
      out.push(
        <VariantRow key={`variants:${g.key}`} group={g} previews={previews} mainOrder={deck.order} mainThumbs={shownThumbs} api={laneApi} failedThumbs={failedLaneThumbs} />,
      );
    }
    if (g && l.changes.filter((c) => c.status === 'pending').length === 1) return out;
    out.push(
      <LaneRow
        key={l.id}
        lane={l}
        preview={previews[l.id]}
        mainOrder={deck.order}
        mainSlides={deck.slides}
        mainThumbs={shownThumbs}
        api={laneApi}
        failedThumbs={failedLaneThumbs}
        onRetryThumbs={(id) => void refreshPreview(id)}
        remarks={openRemarks.filter((r) => r.sourceLaneId === l.id)}
        remarkApi={trackedRemarkApi}
        view={view}
        onReveal={reveal}
        flash={flash === l.id}
        onFlashEnd={(id) => setFlash((f) => (f === id ? null : f))}
      />,
    );
    return out;
  });
  const openCount = mainRemarks.length;
  // The player opens on the selected slide (last of a range); Escape in the player comes back here with it selected.
  const presentSlide = context.kind === 'slide' ? context.slide : context.kind === 'range' ? context.to : null;
  const presentHref = playerHref(presentSlide ? deck.order.indexOf(presentSlide) : -1);
  // Double-click on a main slide: present from it.
  const presentFrom = (id: SlideId): void => openPlayer(playerHref(deck.order.indexOf(id)));
  const rangeCols = context.kind === 'range' ? selectedCols : null;
  const editSlide = (id: SlideId): void => navigate(slidePath(id));
  const editLink = (id: SlideId) => ({ href: slidePath(id), onFollow: () => editSlide(id) });
  const onSelect = (id: SlideId): void => {
    setFocusComposer(pointer.current);
    select(id);
    if (failed.has(id)) refreshThumb(id, generation.current).catch((err: unknown) => console.warn('deckstudio: thumb retry failed', err));
  };
  const gridRow = (children: React.ReactNode, testId?: string): React.ReactNode => (
    <div style={{ display: 'flex' }}>
      <div className="gutter" />
      <div data-testid={testId} style={{ display: 'grid', gridTemplateColumns: `repeat(${deck.order.length}, var(--thumb-w))`, columnGap: 'var(--col-gap)', padding: '0 6px' }}>
        {children}
      </div>
    </div>
  );
  // A propose note shows where the creator asked: in the selection panel while there is one, else in the whole-deck bar.
  const notesInPanel = context.kind !== 'arc';
  const notesBlock =
    notes.length > 0 ? (
          <div role="status" aria-live="polite" style={{ padding: notesInPanel ? 0 : '12px 20px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {notes.map((n) => {
              const href = noteHref(n, remarks, lanes);
              return (
                <div key={n.remarkId} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, lineHeight: 1.4 }}>
                  <span data-testid="propose-note" style={{ flex: 1, minWidth: 0, color: 'var(--grey)' }}>
                    {href ? (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(href);
                        }}
                        style={{ color: 'var(--ink)', fontWeight: 500 }}
                      >
                        lane ready for {n.where}, review it
                      </a>
                    ) : (
                      `asked the co-author for a lane on ${n.where}…`
                    )}
                  </span>
                  <button type="button" aria-label="dismiss" className="link" onClick={() => setNotes((prev) => prev.filter((x) => x.remarkId !== n.remarkId))} style={{ fontSize: 12 }}>
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : null;
  const panelCol = selectedCols?.start ?? null;
  // Anchored on the selection's first column, it runs to the visible right edge. Once the strip pages its column out
  // of view it folds to a one-line bar at the strip's left edge: no empty band holds its height, the lanes move up.
  const panelOff = view !== undefined && panelCol !== null && (panelCol < view.first || panelCol >= view.end);
  const panelView = view && !panelOff ? view : undefined;
  const panelCols = panelCol === null ? 0 : panelSpan(panelCol, panelView);
  const panelMax = room.canvas > 0 ? Math.max(160, room.canvas - PANEL_TOP - room.strip - PANEL_CLEAR) : null;
  const panelSlide = context.kind === 'slide' ? context.slide : context.kind === 'range' ? deck.order[selectedCols?.start ?? 0] : undefined;
  const panelTitle = context.kind === 'slide' ? 'conversation about this slide' : 'conversation about these slides';
  const selectionKey = context.kind === 'slide' ? `slide:${context.slide}` : context.kind === 'range' ? `range:${context.from}:${context.to}` : 'arc';
  const remarkCard = (r: Remark): React.ReactNode => (
    <RemarkPostIt remark={r} onPropose={propose} onResolve={remarkApi.resolveRemark} draftLaneId={draftOf(r)} onOpenLane={openFromRemark} openedLane={openedLane(r)} expandable />
  );
  const panelBar =
    panelOff && panelCol !== null && context.kind !== 'arc' ? (
      <div style={{ display: 'flex', marginTop: 2 }}>
        <div className="gutter" />
        <div data-testid="panel-bar" className="panel-bar">
          <span>conversation about {anchorLabel(context, deck.order)}:</span>
          <button type="button" className="link" onClick={() => reveal(panelCol)} style={{ color: 'var(--ink)' }}>
            show
          </button>
        </div>
      </div>
    ) : null;
  const selectionPanel =
    panelCol !== null && context.kind !== 'arc' && !panelOff ? (
      <div style={{ display: 'flex', marginTop: 2 }}>
        <div className="gutter" />
        <RemarkRow
          testId="selection-row"
          slotTestId="selection-slot"
          columns={deck.order.length}
          maxRows={1}
          view={panelView}
          items={[
            {
              id: 'selection',
              col: panelCol,
              span: panelCols,
              selected: true,
              slide: panelSlide,
              card: (
                <PanelBox
                  data-testid="selection-panel"
                  data-slide={panelSlide}
                  data-kind={context.kind}
                  aria-label={panelTitle}
                  className="selection-panel"
                  style={{ ...(panelMax === null ? {} : { '--panel-max-h': `${panelMax}px` }), position: 'relative', zIndex: 1, padding: 16, borderRadius: 'var(--radius)', background: 'var(--card)', border: '1px solid var(--line)', boxShadow: 'var(--shadow)', cursor: 'auto' } as CSSProperties}
                >
                  <Thread
                    key={context.kind === 'slide' ? `slide:${context.slide}` : 'range'}
                    threadKey={context.kind === 'slide' ? `slide:${context.slide}` : 'global'}
                    title={panelTitle}
                    hint={context.kind === 'slide' ? SLIDE_HINT : RANGE_HINT}
                    context={context}
                    only={context.kind === 'range' ? context : undefined}
                    order={deck.order}
                    slides={deck.slides}
                    api={panelApi}
                    subscribe={fanout}
                    onClearContext={() => setContext({ kind: 'arc' })}
                    onEditContext={editSlide}
                    autoFocus={focusComposer}
                    layout="inline"
                    logMaxHeight={panelMax === null ? 'min(360px, 40vh)' : 'var(--panel-max-h)'}
                    knownLanes={lanes}
                    onShowLane={showLane}
                    lead={
                      panelRemarks.length > 0 || notesBlock ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {panelRemarks.length > 0 ? <PanelRemarks key={selectionKey} remarks={panelRemarks} card={remarkCard} /> : null}
                          {notesBlock}
                        </div>
                      ) : null
                    }
                  />
                </PanelBox>
              ),
            },
          ]}
        />
      </div>
    ) : null;
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <ScreenHeader>
          <h1 className="screen-title">{deck.brief.title || deck.state.name}</h1>
          <span className="meta">v{deck.state.version}</span>
          <span className="meta">{deck.order.length} slides</span>
          <a
            href={BRIEF_PATH}
            onClick={(e) => {
              e.preventDefault();
              navigate(BRIEF_PATH);
            }}
            className="link"
            style={{ marginLeft: 'auto', color: 'var(--ink)', display: 'inline-flex', gap: 6, alignItems: 'baseline' }}
          >
            <span>Brief and checks</span>
            {openCount > 0 ? <span data-testid="remark-count" className="meta">{openCount} open {openCount === 1 ? 'remark' : 'remarks'}</span> : null}
          </a>
          <a href={presentHref} className="btn-primary" title="esc returns here" style={{ alignSelf: 'center' }}>Present</a>
        </ScreenHeader>
        {/* The canvas takes the height left above the versions rail and scrolls both ways; the rail stays put under it. */}
        <div style={{ position: 'relative', flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <main
            ref={canvas}
            data-testid="canvas"
            className="fit-columns"
            onClick={clearOnEmpty}
            style={{ '--strip-h': `${room.strip}px`, flex: 1, minHeight: 0, overflow: 'auto', paddingTop: 8, paddingRight: 24, paddingLeft: 24, paddingBottom: railHeight } as CSSProperties}
          >
            {deck.order.length === 0 ? (
              <p className="muted">This deck has no slides yet. Import a deck.html into the folder to start.</p>
            ) : (
              // max-content: the filmstrip and the lane rows scroll together, so lane columns stay under main's.
              // z-index 0: a stacking context, so the moved hairlines pass under the rows and the remark cards.
              // END_W of right padding: scrolled to the end, the last slide clears the "+N" slot instead of hiding behind it.
              <div ref={rows} style={{ position: 'relative', zIndex: 0, width: 'max-content', minWidth: '100%', display: 'flex', flexDirection: 'column', gap: 24, paddingRight: END_W }}>
                <MoveRisers root={rows} deps={[deck.order, lanes, previews]} />
                <div
                  ref={stripHeader}
                  data-testid="strip-header"
                  className="strip-sticky"
                  onClickCapture={(e) => {
                    shift.current = e.shiftKey;
                    pointer.current = e.detail > 0;
                  }}
                >
                  <Filmstrip
                    order={deck.order}
                    slides={deck.slides}
                    thumbs={shownThumbs}
                    selected={context.kind === 'slide' ? context.slide : rangeCols ? deck.order.slice(rangeCols.start, rangeCols.start + rangeCols.span) : undefined}
                    onSelect={onSelect}
                    onOpen={presentFrom}
                    titleLink={context.kind === 'slide' ? editLink : undefined}
                    remarkDots={dots}
                  />
                  {rangeCols
                    ? gridRow(
                        <div style={{ gridColumn: `${rangeCols.start + 1} / span ${rangeCols.span}`, marginTop: -16, paddingBottom: 4 }}>
                          <div data-testid="range-selection" style={{ height: 2, borderRadius: 1, background: 'var(--accent)' }} />
                          <span data-testid="range-caption" className="meta" style={{ display: 'block', marginTop: 2, color: 'var(--ink)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                            {anchorLabel(context, deck.order)}
                          </span>
                        </div>,
                      )
                    : null}
                </div>
                {selectionPanel || panelBar || remarkError ? (
                  <div style={{ marginTop: -24 }}>
                    {selectionPanel}
                    {panelBar}
                    {remarkError ? (
                      <p style={{ margin: '6px 0 0 var(--gutter)', color: 'var(--warn)', fontSize: 12 }}>
                        <span>Remarks: {remarkError}</span> <button type="button" className="btn" onClick={reloadAll}>Retry</button>
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {laneError && !lanesFailed ? <p style={{ margin: '0 0 0 var(--gutter)', color: 'var(--warn)', fontSize: 12 }}>Lanes: {laneError}</p> : null}
                {lanesFailed ? (
                  <p role="alert" style={{ margin: '0 0 0 var(--gutter)', color: 'var(--warn)', fontSize: 13 }}>
                    <span>Lanes: {lanesFailed}</span> <button type="button" className="btn" onClick={reloadAll}>Retry</button>
                  </p>
                ) : laneRows.length === 0 ? (
                  <p className="muted" style={{ margin: '0 0 0 var(--gutter)', fontSize: 13, maxWidth: 520 }}>
                    No open lanes. Ask the co-author in the thread; its proposals appear here, under the slides they touch.
                  </p>
                ) : (
                  laneRows
                )}
              </div>
            )}
          </main>
          <EdgeFade visible={visible} />
          <StripPager visible={visible} onPage={page} />
        </div>
        <div ref={rail} data-testid="versions-rail" style={{ flex: '0 0 auto', padding: '16px 24px', borderTop: '1px solid var(--line)', background: 'var(--paper)' }}>
          <VersionLine versions={versions} current={deck.state.version} />
        </div>
      </div>
      {/* The whole-deck bar has two fixed widths and its own toggle: a selection never resizes the strip. */}
      {wholeDeck ? (
        <aside data-testid="thread-panel" style={{ width: BAR_OPEN_W, flex: `0 0 ${BAR_OPEN_W}px`, borderLeft: '1px solid var(--line)', background: 'var(--paper)', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <button
            type="button"
            className="link"
            aria-expanded
            aria-label="hide the whole-deck conversation"
            title="Fold the whole-deck conversation to a rail"
            onClick={() => setWholeDeck(false)}
            style={{ alignSelf: 'flex-end', margin: '12px 20px 0', fontSize: 'var(--fs-meta)' }}
          >
            hide
          </button>
          {notesInPanel ? null : notesBlock}
          <div style={{ flex: 1, minHeight: 0 }}>
            <Thread
              threadKey="global"
              title="whole deck"
              hint={DECK_HINT}
              context={WHOLE_DECK}
              order={deck.order}
              slides={deck.slides}
              api={deckApi}
              subscribe={fanout}
            />
          </div>
        </aside>
      ) : (
        <aside data-testid="thread-rail" style={{ width: BAR_SHUT_W, flex: `0 0 ${BAR_SHUT_W}px`, borderLeft: '1px solid var(--line)', background: 'var(--paper)', display: 'flex', justifyContent: 'center', paddingTop: 16 }}>
          <button
            type="button"
            className="link"
            aria-expanded={false}
            onClick={() => setWholeDeck(true)}
            title="Open the conversation about the whole deck"
            style={{ writingMode: 'vertical-rl', fontSize: 'var(--fs-meta)', color: 'var(--ink)' }}
          >
            whole deck
          </button>
        </aside>
      )}
    </div>
  );
}
