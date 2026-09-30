import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Anchor, Lane, Remark, SlideId, Version } from '../../../src/model/types.js';
import {
  BRIEF_PATH,
  getDeck,
  getLane,
  getLanePreview,
  getLanes,
  getRemarks,
  getVersions,
  laneApi,
  navigate,
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
import { Filmstrip } from '../components/Filmstrip.js';
import { FAILED_THUMB, LaneRow, anchorColumns } from '../components/LaneRow.js';
import { RemarkPostIt } from '../components/Remark.js';
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
  const [previews, setPreviews] = useState<Record<string, LanePreviewPayload>>({});
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  // Lane preview thumb hashes the server failed to render.
  const [failedLaneThumbs, setFailedLaneThumbs] = useState<ReadonlySet<string>>(new Set());
  const [laneError, setLaneError] = useState<string | null>(null);
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
      const open = (await getLanes()).sort(byCreated);
      if (laneEpoch.current !== epoch) return;
      setLanes(open);
      setLaneError(null);
      const ids = new Set(open.map((l) => l.id));
      setPreviews((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))));
      await Promise.all(open.map((l) => refreshPreview(l.id)));
    } catch (err) {
      if (laneEpoch.current !== epoch) return;
      setLaneError(errText(err));
    }
  }, [refreshPreview]);

  const reloadRemarks = useCallback(async () => {
    try {
      setRemarks((await getRemarks()).filter((r) => r.status === 'open'));
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
    void reload();
    void reloadLanes();
    void reloadRemarks();
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
      } else if (e.type === 'lane.closed') {
        schedule((q) => q.closed.add(e.laneId));
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
  }, [reload, reloadLanes, reloadRemarks, refreshThumb, schedule]);

  useEffect(() => {
    if (load.status !== 'ready' || !scrollTo.current) return;
    const el = document.querySelector(`[data-testid="thumb"][data-slide="${CSS.escape(scrollTo.current)}"]`);
    scrollTo.current = null;
    el?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [load.status]);

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
    if (e.target instanceof Element && e.target.closest('button, a, input, [data-testid="thumb"]')) return;
    setContext({ kind: 'arc' });
  };

  if (load.status === 'loading') return <div style={{ padding: 32 }} className="muted">Loading deck…</div>;
  if (load.status === 'error') {
    return (
      <div style={{ padding: 32 }}>
        <p style={{ color: 'var(--warn)', fontWeight: 700 }}>Could not load the deck.</p>
        <p className="muted mono">{load.message}</p>
        <button type="button" onClick={() => void reload()}>Retry</button>
      </div>
    );
  }

  const { deck, versions } = load;
  const shownThumbs = failed.size === 0 ? thumbs : Object.fromEntries(deck.order.map((id) => [id, failed.has(id) ? FAILED_THUMB : thumbs[id]]));
  // One post-it per open remark anchored on main, across the columns of its anchor; the grid stacks them.
  // Remarks from a lane-scoped check describe that lane's preview, not main: they go on the lane row.
  const mainRemarks = remarks.filter((r) => !r.sourceLaneId);
  const postIts = mainRemarks.flatMap((remark) => {
    if (remark.anchor.kind === 'arc') return [];
    const cols = anchorColumns(remark.anchor, deck.order);
    return cols ? [{ remark, col: cols.start, span: cols.span }] : [];
  }).sort((a, b) => a.col - b.col);
  const warnCount = mainRemarks.filter((r) => r.severity === 'warn').length;
  const selectedCols = context.kind === 'range' ? anchorColumns(context, deck.order) : null;
  const onSelect = (id: SlideId): void => {
    select(id);
    if (failed.has(id)) refreshThumb(id, generation.current).catch((err: unknown) => console.warn('deckstudio: thumb retry failed', err));
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '16px 24px', borderBottom: '1px solid var(--line)' }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>{deck.brief.title || deck.state.name}</h1>
        <span className="muted mono">v{deck.state.version} · {deck.order.length} slides</span>
        <a
          href={BRIEF_PATH}
          onClick={(e) => {
            e.preventDefault();
            navigate(BRIEF_PATH);
          }}
          style={{ marginLeft: 'auto', color: 'var(--ink)', fontWeight: 600, textDecoration: 'none' }}
        >
          brief &amp; checks{warnCount > 0 ? <span data-testid="warn-badge" className="accent"> · {warnCount}</span> : null}
        </a>
        <a href="/api/present" style={{ color: 'var(--accent)', fontWeight: 700, textDecoration: 'none' }}>Present ▸</a>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <main onClick={clearOnEmpty} style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '20px 24px' }}>
          {deck.order.length === 0 ? (
            <p className="muted">This deck has no slides yet. Import a deck.html into the folder to start.</p>
          ) : (
            // max-content: the filmstrip and the lane rows scroll together, so lane columns stay under main's.
            <div style={{ width: 'max-content', minWidth: '100%', display: 'flex', flexDirection: 'column', gap: 28 }}>
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
                {selectedCols ? (
                  <div style={{ display: 'flex' }}>
                    <div style={{ width: 120, flex: '0 0 120px' }} />
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${deck.order.length}, var(--thumb-w))`, columnGap: 'var(--col-gap)', padding: '0 6px' }}>
                      <div data-testid="range-selection" style={{ gridColumn: `${selectedCols.start + 1} / span ${selectedCols.span}`, height: 3, borderRadius: 2, background: 'var(--accent)' }} />
                    </div>
                  </div>
                ) : null}
                {postIts.length > 0 ? (
                  <div style={{ display: 'flex', marginTop: 8 }}>
                    <div style={{ width: 120, flex: '0 0 120px', fontSize: 12 }} className="muted">remarks</div>
                    <div
                      data-testid="post-its"
                      style={{ display: 'grid', gridTemplateColumns: `repeat(${deck.order.length}, var(--thumb-w))`, columnGap: 'var(--col-gap)', rowGap: 8, gridAutoFlow: 'row dense', alignItems: 'start', padding: '0 6px' }}
                    >
                      {postIts.map(({ remark, col, span }) => (
                        <div key={remark.id} data-testid="post-it-slot" style={{ gridColumn: span > 1 ? `${col + 1} / span ${span}` : `${col + 1}` }}>
                          <RemarkPostIt remark={remark} onPropose={remarkApi.proposeRemark} onResolve={remarkApi.resolveRemark} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {remarkError ? <p style={{ margin: '6px 0 0 126px', color: 'var(--warn)', fontSize: 12 }}>Remarks: {remarkError}</p> : null}
              </div>
              {laneError ? <p style={{ margin: 0, color: 'var(--warn)', fontSize: 12 }}>Lanes: {laneError}</p> : null}
              {lanes.length === 0 ? (
                <p className="muted" style={{ margin: '0 0 0 126px', fontSize: 13 }}>
                  No open lanes. Ask the co-author in the thread; its proposals appear here, under the slides they touch.
                </p>
              ) : (
                lanes.map((l) => (
                  <LaneRow
                    key={l.id}
                    lane={l}
                    preview={previews[l.id]}
                    mainOrder={deck.order}
                    mainThumbs={shownThumbs}
                    api={laneApi}
                    failedThumbs={failedLaneThumbs}
                    onRetryThumbs={(id) => void refreshPreview(id)}
                    remarks={remarks.filter((r) => r.sourceLaneId === l.id)}
                    remarkApi={remarkApi}
                  />
                ))
              )}
            </div>
          )}
        </main>
        <aside style={{ width: 360, flex: '0 0 360px', borderLeft: '1px solid var(--line)', background: 'var(--paper)', minHeight: 0 }}>
          <Thread
            threadKey="global"
            context={context}
            order={deck.order}
            slides={deck.slides}
            api={threadApi}
            subscribe={fanout}
            onClearContext={() => setContext({ kind: 'arc' })}
          />
        </aside>
      </div>
      <footer style={{ borderTop: '1px solid var(--line)', padding: '10px 24px', background: 'var(--paper)' }}>
        <VersionLine versions={versions} current={deck.state.version} />
      </footer>
    </div>
  );
}
