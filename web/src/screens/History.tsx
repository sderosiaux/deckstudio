import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DiffEntry, Slide, SlideId, Snapshot, Version } from '../../../src/model/types.js';
import {
  ApiError,
  historyApi,
  laneOnMainPath,
  navigate as defaultNavigate,
  pairFromSearch,
  subscribe as defaultSubscribe,
  thumbUrl,
  type BusEvent,
  type DeckPayload,
  type HistoryApi,
  type ThumbStatus,
} from '../api.js';
import { DiffFilmstrips } from '../components/DiffFilmstrips.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { VersionLine, type VersionPair } from '../components/VersionLine.js';

export interface HistoryProps {
  api?: HistoryApi;
  subscribe?(handler: (e: BusEvent) => void): () => void;
  navigate?(path: string): void;
  /** The pair to compare first, when the versions exist; defaults to `?a=&b=` of the page URL. */
  initialPair?: VersionPair | null;
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

/** What restoring an entry does to main: the button always says "restore", its label and tooltip say this. */
export const RESTORE_VERB: Record<DiffEntry['kind'], string> = {
  added: 'remove from main',
  removed: 'bring back',
  modified: 'revert content',
  moved: 'move back',
};

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

const chip: CSSProperties = { flex: '0 0 auto', padding: '2px 6px', borderRadius: 4, border: '1px solid var(--line)', fontSize: 12, whiteSpace: 'nowrap' };

/** Compare two versions of main: version line on top, the two filmstrips with diff marks, and what changed with restore. */
export function History({ api = historyApi, subscribe = defaultSubscribe, navigate = defaultNavigate, initialPair = pairFromSearch(location.search) }: HistoryProps) {
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
  /** Whether main already has v<n>'s slides, from diff(current, n), keyed `${current}:${n}`. */
  const [mainHas, setMainHas] = useState<Record<string, boolean>>({});
  const firstPair = useRef(initialPair);
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
        if (!prev) {
          const asked = firstPair.current;
          firstPair.current = null;
          const known = new Set(vs.map((v) => v.n));
          return asked && known.has(asked.a) && known.has(asked.b) ? asked : defaultPair(vs);
        }
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

  // "open vA as a lane" needs to know whether main already has vA's slides. When b is main, the loaded diff answers;
  // otherwise diff(current, a) is asked once per (current, a).
  const current = deck?.state.version;
  const hasKey = pair && current !== undefined ? `${current}:${pair.a}` : null;
  const needsCheck = pair !== null && current !== undefined && pair.a !== current && pair.b !== current && hasKey !== null && !(hasKey in mainHas);
  useEffect(() => {
    if (!needsCheck || !pair || current === undefined || !hasKey) return;
    let live = true;
    api.getHistoryDiff(current, pair.a).then(
      (d) => {
        if (live) setMainHas((prev) => ({ ...prev, [hasKey]: d.entries.length === 0 }));
      },
      // Unknown: the button stays enabled and the server answers if main already has those slides.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, needsCheck, hasKey, current, pair]);

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
      // The server's own sentence ("entry no longer applies: …"), not the HTTP line.
      (err: unknown) => setActionError(err instanceof ApiError ? err.detail : message(err)),
    ).finally(() => setBusy(null));
  };

  const openAsLane = (): void => {
    if (!pair) return;
    const n = pair.a;
    setBusy('lane');
    setActionError(null);
    api.openVersionAsLane(n).then(
      ({ laneId }) => navigate(laneOnMainPath(laneId)),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 409 && current !== undefined) {
          // Main moved to v<n>'s slides since the check: say so and disable the button.
          setMainHas((prev) => ({ ...prev, [`${current}:${n}`]: true }));
          setActionError(`main already has v${n}'s slides`);
        } else {
          setActionError(err instanceof ApiError ? err.detail : message(err));
        }
        setBusy(null);
      },
    );
  };

  if (loadError && !versions) {
    return (
      <div style={{ padding: 32 }}>
        <p style={{ color: 'var(--warn)', fontWeight: 700 }}>Could not load the history.</p>
        <p className="muted mono">{loadError}</p>
        <button type="button" className="btn" onClick={() => void refresh()}>Retry</button>
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
  const aIsMain =
    pair !== null &&
    (pair.a === deck.state.version ||
      (pair.b === deck.state.version ? shown !== null && shown.entries.length === 0 : mainHas[`${deck.state.version}:${pair.a}`] === true));
  const openDisabled = busy !== null || aIsMain;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <ScreenHeader>
          <h1 className="screen-title">Versions</h1>
          <span className="meta" data-testid="history-deck">{deck.state.name}</span>
          <span className="meta" data-testid="history-version">v{deck.state.version}</span>
          {actionError ? <span role="alert" style={{ color: 'var(--warn)', fontSize: 13 }}>{actionError}</span> : null}
          {pair ? (
            <button
              type="button"
              className="btn-primary"
              onClick={openAsLane}
              disabled={openDisabled}
              title={aIsMain ? `main already has v${pair.a}'s slides` : `Propose the changes that bring main back to v${pair.a}`}
              style={{ marginLeft: 'auto', alignSelf: 'center' }}
            >
              Open v{pair.a} as a lane
            </button>
          ) : null}
        </ScreenHeader>
        <section aria-label="compared versions" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '8px 24px 8px' }}>
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
        {/* The version line is the rail at the bottom, as on main. */}
        <div style={{ padding: '14px 24px 16px' }}>
          <p className="meta" style={{ margin: '0 0 10px calc(var(--gutter) + 6px)' }}>click a version to compare from it, shift-click to compare to it</p>
          <VersionLine versions={versions} current={deck.state.version} selection={pair ?? undefined} onSelect={select} />
        </div>
      </div>
      <aside aria-label="what changed" style={{ width: 360, flex: '0 0 360px', borderLeft: '1px solid var(--line)', padding: '18px 20px', overflowY: 'auto' }}>
        <h2 className="screen-title" style={{ marginBottom: 14 }}>What changed</h2>
        {!shown ? null : shown.pair.a === shown.pair.b ? (
          <p className="muted" style={{ fontSize: 13 }}>Both sides are v{shown.pair.a}. Click another version to compare from it, or shift-click to compare to it.</p>
        ) : shown.entries.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>v{shown.pair.a} and v{shown.pair.b} have the same slides in the same order.</p>
        ) : shown.a.order.length === 0 ? (
          // Every row would remove a slide from main: no per-row buttons for a restore that empties the deck.
          <p className="muted" style={{ fontSize: 13 }}>v{shown.pair.a} is empty: restoring would remove every slide</p>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {shown.entries.map((e) => {
              const key = `${e.kind}:${e.slide}`;
              const d = describeEntry(e, shown);
              const does = RESTORE_VERB[e.kind];
              return (
                <li
                  key={key}
                  data-testid="diff-entry"
                  data-kind={e.kind}
                  data-slide={e.slide}
                  onMouseEnter={() => setFocused(e.slide)}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--line)' }}
                >
                  <span className="mono" style={{ ...chip, borderColor: focused === e.slide ? 'var(--ink)' : 'var(--line)' }}>{d.where}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.35 }}>
                    <span style={{ display: 'block' }}>{d.what}</span>
                    <span className="muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.title}>{d.title}</span>
                  </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => restore(e, key)}
                    disabled={busy !== null}
                    aria-label={`restore (${does}): ${d.where}, as in v${shown.pair.a}`}
                    title={`${does[0]!.toUpperCase()}${does.slice(1)}, as in v${shown.pair.a}`}
                    style={{ padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap' }}
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
  );
}
