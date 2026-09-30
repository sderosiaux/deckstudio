import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Anchor, Lane, SlideId, Version } from '../../../src/model/types.js';
import {
  getDeck,
  getLanePreview,
  getLanes,
  getVersions,
  isLaneEvent,
  laneApi,
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
import { Thread } from '../components/Thread.js';
import { VersionLine } from '../components/VersionLine.js';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; deck: DeckPayload; versions: Version[] };

export function Main() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [thumbs, setThumbs] = useState<Record<SlideId, string | undefined>>({});
  // hash -> slide, for thumb.ready events that do not carry a slideId.
  const pending = useRef(new Map<string, SlideId>());
  const generation = useRef(0);
  const mainOrder = useRef<SlideId[]>([]);
  // Nothing selected means the whole deck: the context sent with a message is never null here.
  const [context, setContext] = useState<Anchor>({ kind: 'arc' });
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

  const refreshThumb = useCallback(async (id: SlideId, gen: number) => {
    const t = await thumbFor(id);
    if (gen !== generation.current) return;
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
    const onEvent = (e: BusEvent): void => {
      for (const h of listeners.current) h(e);
      if (e.type === 'deck.changed') {
        // Accepting a change rebases every open lane: all previews are stale.
        void reload();
        void reloadLanes();
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
      }
    };
    return subscribe(onEvent);
  }, [reload, reloadLanes, refreshThumb]);

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
  const selectedCols = context.kind === 'range' ? anchorColumns(context, deck.order) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '16px 24px', borderBottom: '1px solid var(--line)' }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>{deck.brief.title || deck.state.name}</h1>
        <span className="muted mono">v{deck.state.version} · {deck.order.length} slides</span>
        <a href="/api/present" style={{ marginLeft: 'auto', color: 'var(--accent)', fontWeight: 700, textDecoration: 'none' }}>Present ▸</a>
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
                  thumbs={thumbs}
                  selected={context.kind === 'slide' ? context.slide : context.kind === 'range' ? context.to : undefined}
                  onSelect={select}
                />
                {selectedCols ? (
                  <div style={{ display: 'flex' }}>
                    <div style={{ width: 120, flex: '0 0 120px' }} />
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${deck.order.length}, var(--thumb-w))`, columnGap: 'var(--col-gap)', padding: '0 6px' }}>
                      <div data-testid="range-selection" style={{ gridColumn: `${selectedCols.start + 1} / span ${selectedCols.span}`, height: 3, borderRadius: 2, background: 'var(--accent)' }} />
                    </div>
                  </div>
                ) : null}
              </div>
              {laneError ? <p style={{ margin: 0, color: 'var(--warn)', fontSize: 12 }}>Lanes: {laneError}</p> : null}
              {lanes.length === 0 ? (
                <p className="muted" style={{ margin: '0 0 0 126px', fontSize: 13 }}>
                  No open lanes. Ask the co-author in the thread; its proposals appear here, under the slides they touch.
                </p>
              ) : (
                lanes.map((l) => <LaneRow key={l.id} lane={l} preview={previews[l.id]} mainOrder={deck.order} mainThumbs={thumbs} api={laneApi} />)
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
