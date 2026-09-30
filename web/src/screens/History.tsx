import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DiffEntry, Slide, SlideId, Snapshot, Version } from '../../../src/model/types.js';
import {
  historyApi,
  navigate as defaultNavigate,
  subscribe as defaultSubscribe,
  thumbUrl,
  type BusEvent,
  type DeckPayload,
  type HistoryApi,
  type ThumbStatus,
} from '../api.js';
import { DiffFilmstrips } from '../components/DiffFilmstrips.js';
import { VersionLine, type VersionPair } from '../components/VersionLine.js';

export interface HistoryProps {
  api?: HistoryApi;
  subscribe?(handler: (e: BusEvent) => void): () => void;
  navigate?(path: string): void;
}

interface Compared {
  pair: VersionPair;
  a: Snapshot;
  b: Snapshot;
  entries: DiffEntry[];
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The last two versions, older first; one version compares with itself. */
function defaultPair(versions: Version[]): VersionPair | null {
  const ns = versions.map((v) => v.n).sort((x, y) => x - y);
  const last = ns[ns.length - 1];
  if (last === undefined) return null;
  return { a: ns[ns.length - 2] ?? last, b: last };
}

const latestOf = (versions: Version[]): number | undefined => versions.reduce<number | undefined>((m, v) => (m === undefined || v.n > m ? v.n : m), undefined);

/** Same content as the slide on main, so main's thumbnail shows it faithfully. */
function sameSlide(x: Slide, y: Slide | undefined): boolean {
  if (!y) return false;
  return x.title === y.title && x.story === y.story && x.notes === y.notes && x.body === y.body && x.kind === y.kind && JSON.stringify(x.assets) === JSON.stringify(y.assets);
}

const FIELD_LABEL: Record<string, string> = { title: 'title', story: 'story', notes: 'notes', body: 'content', assets: 'assets', kind: 'layout' };

/** One line of "what changed": which slide, and what happened to it between v<a> and v<b>. */
export function describeEntry(e: DiffEntry, c: Compared): { where: string; what: string; title: string } {
  const titleIn = (s: Snapshot): string => s.slides[e.slide]?.title ?? e.slide;
  switch (e.kind) {
    case 'added':
      return { where: `slide ${e.at + 1}`, what: `added in v${c.pair.b}`, title: titleIn(c.b) };
    case 'removed':
      return { where: `slide ${e.wasAt + 1}`, what: `removed in v${c.pair.b}`, title: titleIn(c.a) };
    case 'modified': {
      const fields = e.fields.map((f) => FIELD_LABEL[f] ?? f);
      return { where: `slide ${c.b.order.indexOf(e.slide) + 1}`, what: `${fields.length ? fields.join(', ') : 'content'} changed`, title: titleIn(c.b) };
    }
    case 'moved':
      return { where: `slide ${e.to + 1}`, what: `moved from ${e.from + 1} to ${e.to + 1}`, title: titleIn(c.b) };
  }
}

const card: CSSProperties = { background: 'var(--card)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', padding: 20, minWidth: 0 };
const primary: CSSProperties = { padding: '11px 22px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer', transition: 'opacity .15s ease' };
const secondary: CSSProperties = { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', fontWeight: 600, fontSize: 13, cursor: 'pointer', transition: 'border-color .15s ease' };
const chip: CSSProperties = { flex: '0 0 auto', padding: '3px 8px', borderRadius: 6, background: 'var(--paper)', border: '1px solid var(--line)', fontSize: 12, whiteSpace: 'nowrap' };

/** Compare two versions of main: version line on top, the two filmstrips with diff marks, and what changed with restore. */
export function History({ api = historyApi, subscribe = defaultSubscribe, navigate = defaultNavigate }: HistoryProps) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [deck, setDeck] = useState<DeckPayload | null>(null);
  const [pair, setPair] = useState<VersionPair | null>(null);
  const [compared, setCompared] = useState<Compared | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [focused, setFocused] = useState<SlideId | undefined>(undefined);
  const [mainThumbs, setMainThumbs] = useState<Record<SlideId, ThumbStatus>>({});
  const [reload, setReload] = useState(0);
  const latest = useRef<number | undefined>(undefined);
  /** Thumbnail requests per slide; the token lets an answer for since-invalidated content be ignored. */
  const requested = useRef(new Map<SlideId, object>());
  /** Serialized content of each slide of the main last shown; tells which thumbnails a new main invalidates. */
  const shownSlides = useRef<Record<SlideId, string>>({});
  const generation = useRef(0);

  /**
   * Reloads versions and main. When b was the latest version, b follows the new latest so the comparison stays "against now".
   * Only the thumbnails of slides whose content changed (or that left main) are dropped and asked again; an answer
   * overtaken by a newer refresh is discarded.
   */
  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const [vs, d] = await Promise.all([api.getVersions(), api.getDeck()]);
      if (gen !== generation.current) return;
      const before = latest.current;
      const after = latestOf(vs);
      latest.current = after;
      const stamps: Record<SlideId, string> = Object.fromEntries(d.order.map((id) => [id, JSON.stringify(d.slides[id] ?? null)]));
      const stale = Object.keys({ ...shownSlides.current, ...stamps }).filter((id) => shownSlides.current[id] !== stamps[id]);
      shownSlides.current = stamps;
      for (const id of stale) requested.current.delete(id);
      if (stale.length > 0) {
        setMainThumbs((prev) => {
          const next = { ...prev };
          for (const id of stale) delete next[id];
          return next;
        });
      }
      setDeck(d);
      setVersions(vs);
      setLoadError(null);
      setPair((prev) => {
        if (!prev) return defaultPair(vs);
        if (after !== undefined && prev.b === before && after !== before) return { a: prev.a, b: after };
        return prev;
      });
      setReload((r) => r + 1);
    } catch (err) {
      if (gen === generation.current) setLoadError(message(err));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    return subscribe((e) => {
      if (e.type === 'deck.changed' || e.type === 'hello') void refresh();
      else if (e.type === 'thumb.ready') {
        setMainThumbs((prev) => {
          const hit = Object.entries(prev).filter(([, t]) => t.hash === e.hash && !t.ready);
          if (hit.length === 0) return prev;
          const next = { ...prev };
          for (const [id, t] of hit) next[id] = { ...t, ready: true };
          return next;
        });
      }
    });
  }, [subscribe, refresh]);

  // Fetch both snapshots and the diff for the selected pair; a newer selection discards older answers.
  useEffect(() => {
    if (!pair) return;
    let live = true;
    setDiffError(null);
    Promise.all([api.getVersionSnapshot(pair.a), api.getVersionSnapshot(pair.b), api.getHistoryDiff(pair.a, pair.b)]).then(
      ([a, b, diff]) => {
        if (live) setCompared({ pair, a, b, entries: diff.entries });
      },
      (err: unknown) => {
        if (live) setDiffError(message(err));
      },
    );
    return () => {
      live = false;
    };
  }, [api, pair, reload]);

  // Slides whose content equals main's can borrow main's thumbnail; the others keep the title card.
  useEffect(() => {
    if (!compared || !deck) return;
    const ids = new Set<SlideId>();
    for (const s of [compared.a, compared.b]) for (const id of s.order) if (s.slides[id] && sameSlide(s.slides[id], deck.slides[id])) ids.add(id);
    for (const id of ids) {
      if (requested.current.has(id)) continue;
      const token = {};
      requested.current.set(id, token);
      api.thumbFor(id).then(
        (t) => {
          if (requested.current.get(id) === token) setMainThumbs((prev) => ({ ...prev, [id]: t }));
        },
        () => {
          if (requested.current.get(id) === token) requested.current.delete(id);
        },
      );
    }
  }, [api, compared, deck]);

  const select = (n: number, which: keyof VersionPair): void => setPair((prev) => (prev ? { ...prev, [which]: n } : { a: n, b: n }));

  const restore = (e: DiffEntry, key: string): void => {
    if (!compared) return;
    setBusy(key);
    setActionError(null);
    // No reload here: the server announces the new main with deck.changed, which refreshes the screen once.
    api.restoreEntry(compared.pair.a, e).then(
      () => undefined,
      (err: unknown) => setActionError(message(err)),
    ).finally(() => setBusy(null));
  };

  const openAsLane = (): void => {
    if (!pair) return;
    setBusy('lane');
    setActionError(null);
    api.openVersionAsLane(pair.a).then(
      () => navigate('/'),
      (err: unknown) => {
        setActionError(message(err));
        setBusy(null);
      },
    );
  };

  if (loadError && !versions) {
    return (
      <div style={{ padding: 32 }}>
        <p style={{ color: 'var(--warn)', fontWeight: 700 }}>Could not load the history.</p>
        <p className="muted mono">{loadError}</p>
        <button type="button" onClick={() => void refresh()}>Retry</button>
      </div>
    );
  }
  if (!versions || !deck) return <div style={{ padding: 32 }} className="muted">Loading versions…</div>;

  const thumbsOf = (s: Snapshot): Record<SlideId, string | undefined> =>
    Object.fromEntries(
      s.order.map((id) => {
        const t = mainThumbs[id];
        const slide = s.slides[id];
        return [id, t?.ready && slide && sameSlide(slide, deck.slides[id]) ? thumbUrl(t.hash) : undefined];
      }),
    );
  const shown = compared && pair && compared.pair.a === pair.a && compared.pair.b === pair.b ? compared : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 24px' }}>
        <a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }} style={{ color: 'var(--grey)', textDecoration: 'none', fontWeight: 600 }}>
          ← main
        </a>
        <span className="muted mono">{deck.state.name} · v{deck.state.version}</span>
        {actionError ? <span role="alert" style={{ color: 'var(--warn)', fontSize: 13 }}>{actionError}</span> : null}
        {pair ? (
          <button
            type="button"
            onClick={openAsLane}
            disabled={busy !== null || pair.a === deck.state.version}
            title={pair.a === deck.state.version ? `v${pair.a} is main already` : `Propose the changes that bring main back to v${pair.a}`}
            style={{ ...primary, marginLeft: 'auto', opacity: busy !== null || pair.a === deck.state.version ? 0.6 : 1 }}
          >
            open v{pair.a} as a lane
          </button>
        ) : null}
      </header>
      <div style={{ padding: '0 24px 12px' }}>
        <VersionLine versions={versions} current={deck.state.version} selection={pair ?? undefined} onSelect={select} />
        <p className="muted" style={{ margin: '6px 0 0 132px', fontSize: 12 }}>click a version to compare from it, shift-click to compare to it</p>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 360px', gap: 16, padding: '0 20px 20px' }}>
        <section style={card} aria-label="compared versions">
          {diffError ? (
            <p style={{ color: 'var(--warn)' }}>Could not compare: {diffError}</p>
          ) : !pair ? (
            <p className="muted">No versions yet. Importing a deck creates v0.</p>
          ) : !shown ? (
            <p className="muted">Comparing v{pair.a} and v{pair.b}…</p>
          ) : (
            <DiffFilmstrips
              a={{ n: shown.pair.a, snapshot: shown.a, thumbs: thumbsOf(shown.a) }}
              b={{ n: shown.pair.b, snapshot: shown.b, thumbs: thumbsOf(shown.b) }}
              entries={shown.entries}
              focused={focused}
              onFocus={(id) => setFocused((prev) => (prev === id ? undefined : id))}
            />
          )}
        </section>
        <aside style={{ ...card, overflowY: 'auto' }} aria-label="what changed">
          <h2 style={{ margin: '0 0 12px', fontSize: 20 }}>what changed</h2>
          {!shown ? null : shown.pair.a === shown.pair.b ? (
            <p className="muted" style={{ fontSize: 13 }}>Both sides are v{shown.pair.a}. Click another version to compare from it, or shift-click to compare to it.</p>
          ) : shown.entries.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>v{shown.pair.a} and v{shown.pair.b} have the same slides in the same order.</p>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {shown.entries.map((e) => {
                const key = `${e.kind}:${e.slide}`;
                const d = describeEntry(e, shown);
                return (
                  <li
                    key={key}
                    data-testid="diff-entry"
                    data-kind={e.kind}
                    data-slide={e.slide}
                    onMouseEnter={() => setFocused(e.slide)}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 4px', borderBottom: '1px solid var(--line)', background: focused === e.slide ? 'var(--paper)' : 'transparent', transition: 'background .15s ease' }}
                  >
                    <span className="mono" style={chip}>{d.where}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.35 }}>
                      <span style={{ display: 'block' }}>{d.what}</span>
                      <span className="muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.title}>{d.title}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => restore(e, key)}
                      disabled={busy !== null}
                      aria-label={`restore ${d.where} as in v${shown.pair.a}`}
                      title={`Undo this on main, back to v${shown.pair.a}`}
                      style={{ ...secondary, opacity: busy !== null ? 0.6 : 1 }}
                    >
                      {busy === key ? 'restoring…' : 'restore'}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </aside>
      </div>
    </div>
  );
}
