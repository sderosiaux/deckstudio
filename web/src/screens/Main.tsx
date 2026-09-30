import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlideId, Version } from '../../../src/model/types.js';
import { getDeck, getVersions, subscribe, thumbFor, thumbUrl, type BusEvent, type DeckPayload } from '../api.js';
import { Filmstrip } from '../components/Filmstrip.js';
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
  const [selected, setSelected] = useState<SlideId | undefined>(undefined);
  const [failed, setFailed] = useState<ReadonlySet<SlideId>>(new Set());
  // hash -> slide, for thumb.ready events that do not carry a slideId.
  const pending = useRef(new Map<string, SlideId>());
  const generation = useRef(0);

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
      setLoad({ status: 'ready', deck, versions });
      setThumbs((prev) => Object.fromEntries(deck.order.map((id) => [id, prev[id]])));
      setSelected((s) => (s && deck.order.includes(s) ? s : undefined));
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
    const onEvent = (e: BusEvent): void => {
      if (e.type === 'deck.changed') {
        void reload();
      } else if (e.type === 'thumb.ready') {
        const id = e.slideId ?? pending.current.get(e.hash);
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
  }, [reload, refreshThumb]);

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
  const onSelect = (id: SlideId): void => {
    setSelected(id);
    if (failed.has(id)) refreshThumb(id, generation.current).catch((err: unknown) => console.warn('deckstudio: thumb retry failed', err));
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '16px 24px', borderBottom: '1px solid var(--line)' }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>{deck.brief.title || deck.state.name}</h1>
        <span className="muted mono">v{deck.state.version} · {deck.order.length} slides</span>
        <a href="/api/present" style={{ marginLeft: 'auto', color: 'var(--accent)', fontWeight: 700, textDecoration: 'none' }}>Present ▸</a>
      </header>
      <main style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 24px' }}>
        {deck.order.length === 0 ? (
          <p className="muted">This deck has no slides yet. Import a deck.html into the folder to start.</p>
        ) : (
          <Filmstrip order={deck.order} slides={deck.slides} thumbs={shownThumbs} selected={selected} onSelect={onSelect} />
        )}
      </main>
      <footer style={{ borderTop: '1px solid var(--line)', padding: '10px 24px', background: 'var(--paper)' }}>
        <VersionLine versions={versions} current={deck.state.version} />
      </footer>
    </div>
  );
}
