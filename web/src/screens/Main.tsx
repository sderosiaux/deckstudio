import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type React from 'react';
import type { Anchor, Lane, Remark, SlideId, Version } from '../../../src/model/types.js';
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
  remarkApi,
  selectionFromSearch,
  subscribe,
  threadApi,
  thumbFor,
  thumbUrl,
  type BusEvent,
  type DeckPayload,
  type LanePreviewPayload,
} from '../api.js';
import { EdgeFade, useVisibleColumns } from '../components/EdgeFade.js';
import { Filmstrip } from '../components/Filmstrip.js';
import { FAILED_THUMB, LaneRow, MoveRisers, anchorColumns, laneLetter, movedColumns } from '../components/LaneRow.js';
import { RemarkPostIt, anchorLabel } from '../components/Remark.js';
import { RemarkRow, placeCards, type Pinned } from '../components/RemarkRow.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { Thread } from '../components/Thread.js';
import { VersionLine } from '../components/VersionLine.js';

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
/** Rows of remark cards under the filmstrip. */
const REMARK_ROWS = 1;

/** Focus route of the lane now linked to the note's remark, once the co-author's lane is there with something to review. */
export function noteHref(note: ProposeNote, remarks: readonly Remark[], lanes: readonly Lane[]): string | undefined {
  const laneId = remarks.find((r) => r.id === note.remarkId)?.laneId;
  if (!laneId || (laneId === note.priorLaneId && !note.touched.has(laneId))) return undefined;
  const lane = lanes.find((l) => l.id === laneId && l.status === 'open');
  const first = lane?.changes.find((c) => c.status === 'pending');
  return lane && first ? focusPath(lane.id, first.id) : undefined;
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
  const [lanes, setLanes] = useState<Lane[]>([]);
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
      } else if (e.type === 'lane.created' || e.type === 'lane.updated') {
        schedule((q) => q.refresh.add(e.laneId));
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
  }, [reloadAll, reloadRemarks, refreshThumb, schedule]);

  const canvas = useRef<HTMLElement>(null);
  const rows = useRef<HTMLDivElement>(null);
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

  // Clicking empty space (not a thumb, not a button) clears the selection back to the whole deck.
  const clearOnEmpty = (e: MouseEvent<HTMLElement>): void => {
    if (e.target instanceof Element && e.target.closest('button, a, input, [data-testid="thumb"], [data-testid="post-it"]')) return;
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
  // One card per open remark anchored on main, pinned to the first column of its anchor.
  // Remarks from a lane-scoped check describe that lane's preview, not main: they go on the lane row.
  const openRemarks = remarks.filter((r) => r.status === 'open');
  const mainRemarks = openRemarks.filter((r) => !r.sourceLaneId);
  const propose = async (id: string): Promise<void> => {
    const r = remarks.find((x) => x.id === id);
    await remarkApi.proposeRemark(id);
    const where = !r || r.anchor.kind === 'arc' ? 'the whole deck' : anchorLabel(r.anchor, deck.order);
    const note: ProposeNote = { remarkId: id, where, priorLaneId: r?.laneId ?? null, touched: new Set() };
    setNotes((prev) => [...prev.filter((n) => n.remarkId !== id), note].slice(-MAX_NOTES));
  };
  const trackedRemarkApi = { proposeRemark: propose, resolveRemark: remarkApi.resolveRemark };
  const draftOf = (r: Remark): string | undefined => (r.laneId && drafts.has(r.laneId) ? r.laneId : undefined);
  const pinned: Pinned[] = mainRemarks.flatMap((remark) => {
    if (remark.anchor.kind === 'arc') return [];
    const cols = anchorColumns(remark.anchor, deck.order);
    if (!cols) return [];
    // Selected: the current selection starts inside the remark's columns.
    const selected = selectedCols !== null && selectedCols.start >= cols.start && selectedCols.start < cols.start + cols.span;
    return [
      {
        id: remark.id,
        col: cols.start,
        span: cols.span,
        selected,
        card: (
          <div onClick={() => setContext(remark.anchor)} style={{ cursor: 'pointer' }}>
            <RemarkPostIt remark={remark} onPropose={propose} onResolve={remarkApi.resolveRemark} draftLaneId={draftOf(remark)} onOpenLane={openLane} selected={selected} />
          </div>
        ),
      },
    ];
  });
  // Moved hairlines run from main's thumbs down to their lane: the remark cards they pass keep clear of their columns.
  const movedByLane = lanes.map((l) => movedColumns(l, previews[l.id], deck.order));
  const movedBelow = (i: number): ReadonlySet<number> => new Set(movedByLane.slice(i).flat());
  const mainAvoid = movedBelow(0);
  // Main keeps its lanes in view: one row of cards, the selection's own remarks first; the pins still mark every slide.
  const hiddenRemarks = pinned.length - placeCards(pinned, deck.order.length, REMARK_ROWS, view, mainAvoid).length;
  const warnCount = mainRemarks.filter((r) => r.severity === 'warn').length;
  // The player opens on the selected slide (last of a range); Escape in the player comes back here with it selected.
  const presentSlide = context.kind === 'slide' ? context.slide : context.kind === 'range' ? context.to : null;
  const presentIndex = presentSlide ? deck.order.indexOf(presentSlide) : -1;
  const presentHref = presentIndex >= 0 ? `/api/present#${presentIndex + 1}` : '/api/present';
  const rangeCols = context.kind === 'range' ? selectedCols : null;
  const onSelect = (id: SlideId): void => {
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
            {warnCount > 0 ? <span data-testid="warn-badge" className="meta">{warnCount}</span> : null}
          </a>
          <a href={presentHref} className="btn-primary" title="esc returns here" style={{ alignSelf: 'center' }}>Present</a>
        </ScreenHeader>
        {/* Sized to its rows (scrolling past the window height): the versions rail follows 48px under the lowest lane element. */}
        <div style={{ position: 'relative', flex: '0 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <main ref={canvas} data-testid="canvas" className="fit-columns" onClick={clearOnEmpty} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 24px 24px 24px' }}>
            {deck.order.length === 0 ? (
              <p className="muted">This deck has no slides yet. Import a deck.html into the folder to start.</p>
            ) : (
              // max-content: the filmstrip and the lane rows scroll together, so lane columns stay under main's.
              // z-index 0: a stacking context, so the moved hairlines pass under the rows and the remark cards.
              <div ref={rows} style={{ position: 'relative', zIndex: 0, width: 'max-content', minWidth: '100%', display: 'flex', flexDirection: 'column', gap: 24 }}>
                <MoveRisers root={rows} deps={[deck.order, lanes, previews]} />
                <div
                  onClickCapture={(e) => {
                    shift.current = e.shiftKey;
                  }}
                >
                  <Filmstrip
                    order={deck.order}
                    slides={deck.slides}
                    thumbs={shownThumbs}
                    selected={context.kind === 'slide' ? context.slide : context.kind === 'range' ? context.to : undefined}
                    onSelect={onSelect}
                  />
                  {rangeCols
                    ? gridRow(<div data-testid="range-selection" style={{ gridColumn: `${rangeCols.start + 1} / span ${rangeCols.span}`, height: 2, borderRadius: 1, background: 'var(--accent)' }} />)
                    : null}
                  {pinned.length > 0 ? (
                    <div style={{ display: 'flex', marginTop: 2 }}>
                      <div className="gutter" style={{ paddingTop: 14 }}>
                        {hiddenRemarks > 0 ? (
                          <span className="meta" data-testid="remarks-more" style={{ display: 'block' }}>
                            {hiddenRemarks} more {hiddenRemarks === 1 ? 'remark' : 'remarks'}: select a slide to see its own
                          </span>
                        ) : null}
                      </div>
                      <RemarkRow testId="post-its" items={pinned} columns={deck.order.length} maxRows={REMARK_ROWS} view={view} avoid={mainAvoid} />
                    </div>
                  ) : null}
                  {remarkError ? (
                    <p style={{ margin: '6px 0 0 var(--gutter)', color: 'var(--warn)', fontSize: 12 }}>
                      <span>Remarks: {remarkError}</span> <button type="button" className="btn" onClick={reloadAll}>Retry</button>
                    </p>
                  ) : null}
                </div>
                {laneError && !lanesFailed ? <p style={{ margin: '0 0 0 var(--gutter)', color: 'var(--warn)', fontSize: 12 }}>Lanes: {laneError}</p> : null}
                {lanesFailed ? (
                  <p role="alert" style={{ margin: '0 0 0 var(--gutter)', color: 'var(--warn)', fontSize: 13 }}>
                    <span>Lanes: {lanesFailed}</span> <button type="button" className="btn" onClick={reloadAll}>Retry</button>
                  </p>
                ) : lanes.length === 0 ? (
                  <p className="muted" style={{ margin: '0 0 0 var(--gutter)', fontSize: 13, maxWidth: 520 }}>
                    No open lanes. Ask the co-author in the thread; its proposals appear here, under the slides they touch.
                  </p>
                ) : (
                  lanes.map((l, i) => (
                    <LaneRow
                      key={l.id}
                      lane={l}
                      letter={laneLetter(i)}
                      preview={previews[l.id]}
                      mainOrder={deck.order}
                      mainThumbs={shownThumbs}
                      api={laneApi}
                      failedThumbs={failedLaneThumbs}
                      onRetryThumbs={(id) => void refreshPreview(id)}
                      remarks={openRemarks.filter((r) => r.sourceLaneId === l.id)}
                      remarkApi={trackedRemarkApi}
                      view={view}
                      avoid={movedBelow(i + 1)}
                    />
                  ))
                )}
              </div>
            )}
          </main>
          <EdgeFade visible={visible} />
        </div>
        {/* 24px here plus the canvas's 24px bottom padding. */}
        <div style={{ padding: '24px 24px 16px' }}>
          <VersionLine versions={versions} current={deck.state.version} />
        </div>
      </div>
      <aside data-testid="thread-panel" style={{ width: 360, flex: '0 0 360px', borderLeft: '1px solid var(--line)', background: 'var(--paper)', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {notes.length > 0 ? (
          <div role="status" aria-live="polite" style={{ padding: '12px 20px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
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
        ) : null}
        <div style={{ flex: 1, minHeight: 0 }}>
          <Thread
            threadKey="global"
            context={context}
            order={deck.order}
            slides={deck.slides}
            api={threadApi}
            subscribe={fanout}
            onClearContext={() => setContext({ kind: 'arc' })}
          />
        </div>
      </aside>
    </div>
  );
}
