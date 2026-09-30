import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Anchor, Lane, Remark, SlideId, Version } from '../../../src/model/types.js';
import {
  BRIEF_PATH,
  getDeck,
  getLanePreview,
  getLanes,
  getRemarks,
  getVersions,
  isLaneEvent,
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
import { LaneRow, anchorColumns } from '../components/LaneRow.js';
import { RemarkPostIt } from '../components/Remark.js';
import { Thread } from '../components/Thread.js';
import { VersionLine } from '../components/VersionLine.js';

// Shown in the thumb slot when the server reports a failed render; clicking that thumb re-requests it.
const FAILED_THUMB = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#F3E3DD"/>' +
    '<text x="80" y="50" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" font-weight="600" fill="#B8432A">render failed · retry</text></svg>',
)}`;

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; deck: DeckPayload; versions: Version[] };

export function Main() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [thumbs, setThumbs] = useState<Record<SlideId, string | undefined>>({});
  const [failed, setFailed] = useState<ReadonlySet<SlideId>>(new Set());
  // hash -> slide, for thumb.ready events that do not carry a slideId.
  const pending = useRef(new Map<string, SlideId>());
  const generation = useRef(0);
  const mainOrder = useRef<SlideId[]>([]);
  // Nothing selected means the whole deck: the context sent with a message is never null here.
  // `?select=` comes from "show" on the brief & checks screen; reload() drops it if the slide is gone.
  const [context, setContext] = useState<Anchor>(() => selectionFromSearch(location.search) ?? { kind: 'arc' });
  const scrollTo = useRef<SlideId | null>(context.kind === 'slide' ? context.slide : context.kind === 'range' ? context.from : null);
  const [remarks, setRemarks] = useState<Remark[]>([]);
  const [remarkError, setRemarkError] = useState<string | null>(null);
  const shift = useRef(false);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [previews, setPreviews] = useState<Record<string, LanePreviewPayload>>({});
  const [laneError, setLaneError] = useState<string | null>(null);
  // Latest request per lane, so a slow preview never overwrites a newer one.
  const laneGen = useRef(new Map<string, number>());
  // One WebSocket for the screen; children (the thread) register here instead of opening their own.
  const listeners = useRef(new Set<(e: BusEvent) => void>());
  const fanout = useCallback((h: (e: BusEvent) => void) => {
    listeners.current.add(h);
    return () => {
      listeners.current.delete(h);
    };
  }, []);

  const refreshPreview = useCallback(async (laneId: string) => {
    const gen = (laneGen.current.get(laneId) ?? 0) + 1;
    laneGen.current.set(laneId, gen);
    try {
      const p = await getLanePreview(laneId);
      if (laneGen.current.get(laneId) !== gen) return;
      setPreviews((prev) => ({ ...prev, [laneId]: p }));
    } catch (err) {
      if (laneGen.current.get(laneId) !== gen) return;
      setLaneError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const reloadLanes = useCallback(async () => {
    try {
      const open = (await getLanes()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      setLanes(open);
      setLaneError(null);
      const ids = new Set(open.map((l) => l.id));
      setPreviews((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))));
      await Promise.all(open.map((l) => refreshPreview(l.id)));
    } catch (err) {
      setLaneError(err instanceof Error ? err.message : String(err));
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
      pending.current.clear();
      mainOrder.current = deck.order;
      setContext((c) => (anchorColumns(c, deck.order) ? c : { kind: 'arc' }));
      setLoad({ status: 'ready', deck, versions });
      setThumbs((prev) => Object.fromEntries(deck.order.map((id) => [id, prev[id]])));
      // Sequential on purpose: the server renders one thumb at a time, so asking in deck order
      // makes thumbs appear left to right.
      for (const id of deck.order) {
        if (gen !== generation.current) return;
        await refreshThumb(id, gen);
      }
    } catch (err) {
      if (gen !== generation.current) return;
      setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [refreshThumb]);

  useEffect(() => {
    void reload();
    void reloadLanes();
    void reloadRemarks();
    // The selection is now in state; a later reload should not re-apply a stale query.
    if (location.search) history.replaceState(null, '', location.pathname);
    const onEvent = (e: BusEvent): void => {
      for (const h of listeners.current) h(e);
      if (e.type === 'deck.changed') {
        // Accepting a change rebases every open lane: all previews are stale.
        void reload();
        void reloadLanes();
        void reloadRemarks();
      } else if (e.type === 'remarks.changed') {
        void reloadRemarks();
      } else if (isLaneEvent(e)) {
        void reloadLanes();
      } else if (e.type === 'thumb.ready') {
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
        const id = e.slideId ?? pending.current.get(e.hash);
        if (!id) return;
        pending.current.delete(e.hash);
        console.warn(`deckstudio: thumbnail render failed for ${id}: ${e.message}`);
        setFailed((prev) => new Set(prev).add(id));
      }
    };
    return subscribe(onEvent);
  }, [reload, reloadLanes, reloadRemarks, refreshThumb]);

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
  // One post-it per open remark anchored on main, under the first column of its anchor; the grid stacks them.
  const postIts = remarks.flatMap((remark) => {
    if (remark.anchor.kind === 'arc') return [];
    const cols = anchorColumns(remark.anchor, deck.order);
    return cols ? [{ remark, col: cols.start }] : [];
  }).sort((a, b) => a.col - b.col);
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
          brief &amp; checks{remarks.some((r) => r.severity === 'warn') ? <span className="accent"> · {remarks.filter((r) => r.severity === 'warn').length}</span> : null}
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
                      {postIts.map(({ remark, col }) => (
                        <div key={remark.id} style={{ gridColumn: `${col + 1}` }}>
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
                lanes.map((l) => <LaneRow key={l.id} lane={l} preview={previews[l.id]} mainOrder={deck.order} mainThumbs={shownThumbs} api={laneApi} />)
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
