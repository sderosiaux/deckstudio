import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { DiffEntry, Slide, SlideId, Snapshot, Version } from '../../../src/model/types.js';
import {
  ApiError,
  historyApi,
  historyPath,
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
import { SlidePreview } from '../components/SlidePreview.js';
import { BackToMain, ScreenHeader } from '../components/ScreenHeader.js';
import { EMPTY_VERSION, VersionLine, type VersionPair } from '../components/VersionLine.js';

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

/** How long the "done: vN, undo" line stays in place of a restored row. */
export const RESTORE_DONE_MS = 6000;

/** A restore that went through: the version it made and how to take it back (the inverse entry, from the version before). */
interface Done {
  key: string;
  /** Where the row was in the list: the line keeps that place even when the entry left the comparison. */
  index: number;
  before: number;
  after: number;
  slide: SlideId;
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

/** A version's box on the rail, in the rail's scroll coordinates. */
export interface RailBox {
  left: number;
  right: number;
}

/** Inset kept between a compared version and the rail's edges (its side padding). */
const RAIL_PAD = 6;

/**
 * Where the rail scrolls for a compared pair: both versions in view when they fit (moving as little as possible),
 * otherwise the earlier one at the start, the later one reached through the edge chip.
 */
export function railScrollFor(view: { scrollLeft: number; width: number }, lo: RailBox, hi: RailBox): number {
  const fits = hi.right - lo.left <= view.width - 2 * RAIL_PAD;
  if (!fits) return Math.max(0, lo.left - RAIL_PAD);
  if (lo.left < view.scrollLeft + RAIL_PAD) return Math.max(0, lo.left - RAIL_PAD);
  if (hi.right > view.scrollLeft + view.width - RAIL_PAD) return hi.right - view.width + RAIL_PAD;
  return view.scrollLeft;
}

/** A compared version the rail has scrolled out of view, and on which side it lies. */
interface RailChip {
  n: number;
  role: 'from' | 'to';
  side: 'left' | 'right';
}

/** The words that say what happened to a slide between the two sides; empty when it kept its place and content. */
export function changeWords(id: SlideId, entries: DiffEntry[]): string[] {
  return entries.flatMap((e) =>
    e.slide !== id ? [] : e.kind === 'added' ? ['added'] : e.kind === 'removed' ? ['removed'] : e.kind === 'modified' ? ['modified'] : [`moved from ${e.from + 1}`],
  );
}

/** Space between the two large renders, and SlidePreview's own chrome: 12px padding around a 16px label line, 8px gap, 1px frame. */
const PAIR_GAP = 24;
const CARD_CHROME_W = 26;
const CARD_CHROME_H = 50;
/** The pane's padding: the rows' 6px inset on the sides, room for the 2px change ring above and below. */
const PANE_PAD_X = 6;
const PANE_PAD_Y = 4;

/** The width of each of the two cards: half the pane, unless the pane's height holds less of a 16:9 slide. */
export function pairCardWidth(pane: { width: number; height: number }): number {
  const byWidth = (pane.width - PAIR_GAP) / 2;
  const byHeight = ((pane.height - CARD_CHROME_H) * 16) / 9 + CARD_CHROME_W;
  return Math.max(160, Math.floor(Math.min(byWidth, byHeight)));
}

/** How many of the other side's slides the context card shows on each side of the gap. */
const CONTEXT_EACH_SIDE = 2;

/** Where a slide that one side only has would sit on the other: the gap's index there, and its slides just before and after it. */
export interface SlidePlace {
  /** 0-based index in the other side's order where the slide would go. */
  at: number;
  before: SlideId[];
  after: SlideId[];
}

/**
 * Anchored on the nearest slide before it (on its own side) that the other side also has, else on the nearest one
 * after it; null when the two sides share no slide around it.
 */
export function placeIn(id: SlideId, own: Snapshot, other: Snapshot): SlidePlace | null {
  const i = own.order.indexOf(id);
  if (i < 0) return null;
  const prev = own.order.slice(0, i).reverse().find((x) => other.order.includes(x));
  const next = own.order.slice(i + 1).find((x) => other.order.includes(x));
  const at = prev !== undefined ? other.order.indexOf(prev) + 1 : next !== undefined ? other.order.indexOf(next) : -1;
  if (at < 0) return null;
  return { at, before: other.order.slice(Math.max(0, at - CONTEXT_EACH_SIDE), at), after: other.order.slice(at, at + CONTEXT_EACH_SIDE) };
}

/** "between slides 2 and 3", "after slide 5", "before slide 1": in the other side's numbers. */
const placeWords = (p: SlidePlace): string =>
  p.before.length && p.after.length ? `between slides ${p.at} and ${p.at + 1}` : p.before.length ? `after slide ${p.at}` : `before slide ${p.at + 1}`;

interface ContextCardProps {
  label: string;
  /** "not in v1" or "removed in v3". */
  absent: string;
  /** "it comes" or "it sat". */
  verb: string;
  width: number | undefined;
  place: SlidePlace | null;
  side: Snapshot;
  thumbs: Record<SlideId, string | undefined>;
}

/**
 * The side of the compare where the slide does not exist: not an empty dashed frame but that side's slides around its
 * place, two before and two after, the gap marked between them, at the size of the render it faces. Same card as
 * SlidePreview's; the thumbs size from the frame's own box (a size container) so the two rows fill it.
 */
function ContextCard({ label, absent, verb, width, place, side, thumbs }: ContextCardProps) {
  // A lone slide before the gap sits next to it, in the second column, so the strip still reads left to right.
  const cell = (id: SlideId, i: number, all: SlideId[]) => {
    const n = side.order.indexOf(id) + 1;
    const title = side.slides[id]?.title ?? id;
    return (
      <figure key={id} data-testid="context-thumb" data-slide={id} className="compare-context-thumb" style={all === place?.before && all.length === 1 && i === 0 ? { gridColumn: 2 } : undefined}>
        <div className="compare-context-img">
          {thumbs[id] ? <img src={thumbs[id]} alt={title} draggable={false} /> : <span>{title}</span>}
        </div>
        <figcaption className="meta">slide {n}</figcaption>
      </figure>
    );
  };
  return (
    <figure data-testid="slide-preview" data-variant="missing" aria-label={label} className="compare-context" style={width === undefined ? undefined : { width, flex: `0 0 ${width}px` }}>
      <figcaption className="compare-context-label" title={label}>{label}</figcaption>
      <div className="compare-context-frame">
        {place ? (
          <div className="compare-context-grid">
            {place.before.map(cell)}
            <div data-testid="context-gap" className="compare-context-gap" />
            {place.after.map(cell)}
          </div>
        ) : null}
        <p className="compare-context-text">{place ? `${absent}, ${verb} ${placeWords(place)}` : absent}</p>
      </div>
    </figure>
  );
}

interface ComparePairProps {
  compared: Compared;
  slide: SlideId;
  thumbsA: Record<SlideId, string | undefined>;
  thumbsB: Record<SlideId, string | undefined>;
}

/**
 * One slide at reading size, as it was in v<a> and as it is in v<b>, side by side under the strips: the strips say
 * where things changed, this pair shows what. The cards take the pane's height, so the screen holds slides, not paper.
 */
function ComparePair({ compared, slide, thumbsA, thumbsB }: ComparePairProps) {
  const pane = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const measure = (): void => {
      // The inner box: clientWidth/Height include the pane's padding, which keeps the cards' rings in view.
      const next = { width: el.clientWidth - 2 * PANE_PAD_X, height: el.clientHeight - 2 * PANE_PAD_Y };
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const { pair, a, b, entries } = compared;
  const words = changeWords(slide, entries);
  const changed = words.length > 0;
  const atA = a.order.indexOf(slide);
  const atB = b.order.indexOf(slide);
  const width = size && size.width > 0 && size.height > 0 ? pairCardWidth(size) : undefined;
  const title = (s: Snapshot): string => s.slides[slide]?.title ?? slide;
  const entry = entries.find((e) => e.slide === slide);
  return (
    <div style={{ display: 'flex', flex: '1 1 0', minHeight: 0 }}>
      <div className="gutter row-label" data-testid="compare-what" style={{ position: 'static', paddingTop: 12, color: changed ? 'var(--accent)' : 'var(--grey)' }}>
        {entry ? describeEntry(entry, compared).what : 'unchanged'}
      </div>
      <div ref={pane} data-testid="compare-pair" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', gap: PAIR_GAP, alignItems: 'flex-start', padding: `${PANE_PAD_Y}px ${PANE_PAD_X}px`, overflow: 'hidden' }}>
        {atA >= 0 ? (
          <SlidePreview label={`v${pair.a}, slide ${atA + 1}`} variant="main" title={title(a)} url={thumbsA[slide]} width={width} />
        ) : (
          <ContextCard label={`v${pair.a}, not in v${pair.a}`} absent={`not in v${pair.a}`} verb="it comes" width={width} place={placeIn(slide, b, a)} side={a} thumbs={thumbsA} />
        )}
        {atB >= 0 ? (
          <SlidePreview label={`v${pair.b}, slide ${atB + 1}${changed ? `, ${words.join(', ')}` : ''}`} variant={changed ? 'lane' : 'main'} title={title(b)} url={thumbsB[slide]} width={width} />
        ) : (
          <ContextCard label={`v${pair.b}, removed`} absent={`removed in v${pair.b}`} verb="it sat" width={width} place={placeIn(slide, a, b)} side={b} thumbs={thumbsB} />
        )}
      </div>
    </div>
  );
}

const rowButton: CSSProperties = { padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap' };
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
  /** The row whose restore waits for a second click. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [focused, setFocused] = useState<SlideId | undefined>(undefined);
  const [mainThumbs, setMainThumbs] = useState<Record<SlideId, ThumbStatus>>({});
  /** Renders of slides as they were in a past version, keyed `${n}:${id}`: a version never changes, so neither do they. */
  const [versionThumbs, setVersionThumbs] = useState<Record<string, ThumbStatus>>({});
  const versionAsked = useRef(new Set<string>());
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
  /** Holds the versions rail; its <ol> is the scroller. */
  const railBox = useRef<HTMLDivElement>(null);
  const [railChips, setRailChips] = useState<RailChip[]>([]);

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
        setVersionThumbs((prev) => {
          const hit = Object.entries(prev).filter(([, t]) => t.hash === e.hash && !t.ready);
          if (hit.length === 0) return prev;
          const next = { ...prev };
          for (const [key, t] of hit) next[key] = { ...t, ready: true };
          return next;
        });
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

  // Slides whose content equals main's borrow main's thumbnail; the others are rendered as they were in their version.
  // The title card only stands in while a render is on its way.
  useEffect(() => {
    if (!compared || !deck) return;
    const ids = new Set<SlideId>();
    const sides: [number, Snapshot][] = [[compared.pair.a, compared.a], [compared.pair.b, compared.b]];
    for (const [n, s] of sides) {
      for (const id of s.order) {
        const slide = s.slides[id];
        if (!slide) continue;
        if (sameSlide(slide, deck.slides[id])) {
          ids.add(id);
          continue;
        }
        const key = `${n}:${id}`;
        if (versionAsked.current.has(key)) continue;
        versionAsked.current.add(key);
        api.thumbForVersion(n, id).then(
          (t) => setVersionThumbs((prev) => ({ ...prev, [key]: t })),
          () => versionAsked.current.delete(key),
        );
      }
    }
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

  // The pair lives in the URL: leaving the history and coming back (or reloading) finds the same compare.
  useEffect(() => {
    if (!pair) return;
    const path = historyPath(pair.a, pair.b);
    if (`${location.pathname}${location.search}` !== path) history.replaceState(history.state, '', path);
  }, [pair]);

  /** The compared versions out of the rail's view, as chips on the edge they lie past. */
  const measureRail = useCallback((): void => {
    const ol = railBox.current?.querySelector('ol');
    const next: RailChip[] = [];
    if (ol && pair) {
      for (const [n, role] of [[pair.a, 'from'], [pair.b, 'to']] as const) {
        if (role === 'to' && n === pair.a) continue;
        const li = ol.querySelector<HTMLElement>(`[data-version="${n}"]`);
        if (!li) continue;
        const left = li.offsetLeft;
        const right = left + li.offsetWidth;
        if (right <= ol.scrollLeft) next.push({ n, role, side: 'left' });
        else if (left >= ol.scrollLeft + ol.clientWidth) next.push({ n, role, side: 'right' });
      }
    }
    setRailChips((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [pair]);

  // After the rail's own scroll into view (a child's layout effect runs first): both compared versions when they fit,
  // else the earlier one, with a chip at the edge for the other.
  const versionCount = versions?.length ?? 0;
  useLayoutEffect(() => {
    const ol = railBox.current?.querySelector('ol');
    if (!ol || !pair) return;
    const box = (n: number): RailBox | null => {
      const li = ol.querySelector<HTMLElement>(`[data-version="${n}"]`);
      return li ? { left: li.offsetLeft, right: li.offsetLeft + li.offsetWidth } : null;
    };
    const lo = box(Math.min(pair.a, pair.b));
    const hi = box(Math.max(pair.a, pair.b));
    if (lo && hi) ol.scrollLeft = railScrollFor({ scrollLeft: ol.scrollLeft, width: ol.clientWidth }, lo, hi);
    measureRail();
    ol.addEventListener('scroll', measureRail, { passive: true });
    return () => ol.removeEventListener('scroll', measureRail);
  }, [pair, versionCount, measureRail]);

  const revealOnRail = (n: number): void => {
    const ol = railBox.current?.querySelector('ol');
    const li = ol?.querySelector<HTMLElement>(`[data-version="${n}"]`);
    if (!ol || !li) return;
    const left = li.offsetLeft;
    const right = left + li.offsetWidth;
    ol.scrollLeft = left < ol.scrollLeft ? Math.max(0, left - RAIL_PAD) : right - ol.clientWidth + RAIL_PAD;
    measureRail();
  };

  // A plain click on the version already compared to would compare it with itself: it does nothing.
  const select = (n: number, which: keyof VersionPair): void =>
    setPair((prev) => (!prev ? { a: n, b: n } : which === 'a' && n === prev.b ? prev : { ...prev, [which]: n }));
  const swap = (): void => setPair((prev) => (prev ? { a: prev.b, b: prev.a } : prev));

  // The done line goes away on its own; a newer restore restarts the count.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), RESTORE_DONE_MS);
    return () => clearTimeout(t);
  }, [done]);

  const failed = (err: unknown): void => setActionError(err instanceof ApiError ? err.detail : message(err));

  const restore = (e: DiffEntry, key: string, index: number): void => {
    if (!compared || !deck) return;
    const before = deck.state.version;
    setConfirming(null);
    setDone(null);
    setBusy(key);
    setActionError(null);
    // No reload here: the server announces the new main with deck.changed, which refreshes the screen once.
    api
      .restoreEntry(compared.pair.a, e)
      .then(async () => {
        const after = (await api.getDeck()).state.version;
        setDone({ key, index, before, after, slide: e.slide });
      })
      // The server's own sentence ("entry no longer applies: …"), not the HTTP line.
      .catch(failed)
      .finally(() => setBusy(null));
  };

  /** Takes a restore back: the change v<before> to v<after> made to that slide, restored from v<before>. */
  const undo = (d: Done): void => {
    setBusy('undo');
    setActionError(null);
    api
      .getHistoryDiff(d.before, d.after)
      .then(async ({ entries }) => {
        const inverse = entries.find((x) => x.slide === d.slide);
        if (!inverse) throw new Error(`v${d.after} no longer differs from v${d.before} on that slide`);
        await api.restoreEntry(d.before, inverse);
        setDone(null);
      })
      .catch(failed)
      .finally(() => setBusy(null));
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

  const doneRow = (d: Done) => (
    <li key={`done:${d.key}`} data-testid="restore-done" role="status" style={{ display: 'flex', alignItems: 'baseline', gap: 4, padding: '12px 0', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
      {`done: v${d.after}, `}
      <button type="button" className="link" onClick={() => undo(d)} disabled={busy !== null} style={{ color: 'var(--ink)', textDecoration: 'underline' }}>undo</button>
    </li>
  );
  /** The list with the done line at the place of the row it replaced, when that entry left the comparison. */
  const withDone = (rows: ReactElement[]): ReactElement[] => {
    if (!done || rows.some((r) => r.key === `done:${done.key}`)) return rows;
    const at = Math.min(done.index, rows.length);
    return [...rows.slice(0, at), doneRow(done), ...rows.slice(at)];
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

  const thumbsOf = (n: number, s: Snapshot): Record<SlideId, string | undefined> =>
    Object.fromEntries(
      s.order.map((id) => {
        const slide = s.slides[id];
        const t = slide && sameSlide(slide, deck.slides[id]) ? mainThumbs[id] : versionThumbs[`${n}:${id}`];
        return [id, t?.ready ? thumbUrl(t.hash) : undefined];
      }),
    );
  const shown = compared && pair && compared.pair.a === pair.a && compared.pair.b === pair.b ? compared : null;
  const aIsMain =
    pair !== null &&
    (pair.a === deck.state.version ||
      (pair.b === deck.state.version ? shown !== null && shown.entries.length === 0 : mainHas[`${deck.state.version}:${pair.a}`] === true));
  const aEmpty = pair !== null && versions.some((v) => v.n === pair.a && v.order.length === 0);
  const openDisabled = busy !== null || aIsMain || aEmpty;
  // The slide shown large: the one picked in the strips or hovered in the list, else the first change, else the first slide.
  const inShown = (id: SlideId | undefined): id is SlideId => id !== undefined && shown !== null && (id in shown.a.slides || id in shown.b.slides);
  const pairSlide = !shown ? undefined : inShown(focused) ? focused : (shown.entries[0]?.slide ?? shown.b.order[0] ?? shown.a.order[0]);

  return (
    <div className="history-layout">
      <ScreenHeader>
        <h1 className="screen-title">Versions</h1>
        <span className="meta" data-testid="history-deck">{deck.state.name}</span>
        <span className="meta" data-testid="history-version">v{deck.state.version}</span>
        {/* How the rail at the foot picks the pair: said up here, where the header has room, so the rail's line goes to the renders. */}
        <span className="meta" style={{ marginLeft: 12 }}>click a version below to compare from it, shift-click to compare to it</span>
        {pair && pair.a !== pair.b ? (
          <button type="button" className="link" onClick={swap} style={{ fontSize: 12, color: 'var(--ink)' }}>swap</button>
        ) : null}
        {actionError ? <span role="alert" style={{ color: 'var(--warn)', fontSize: 13 }}>{actionError}</span> : null}
        <BackToMain navigate={navigate} />
        {pair ? (
          <button
            type="button"
            className="btn-primary"
            onClick={openAsLane}
            disabled={openDisabled}
            title={aEmpty ? `v${pair.a} is ${EMPTY_VERSION}` : aIsMain ? `main already has v${pair.a}'s slides` : `Propose the changes that bring main back to v${pair.a}`}
            style={{ marginLeft: 8, alignSelf: 'center' }}
          >
            Open v{pair.a} as a lane
          </button>
        ) : null}
      </ScreenHeader>
      {/*
        * The strips size to their rows, "what changed" beside them at their height; the large pair and the rail span
        * the whole width under both, so no column of paper runs down beside the renders.
        */}
      <div className="history-top">
        <section aria-label="compared versions" className="history-strips">
          {diffError ? (
            <p style={{ color: 'var(--warn)' }}>Could not compare: {diffError}</p>
          ) : !pair ? (
            <p className="muted">No versions yet. Importing a deck creates v0.</p>
          ) : !shown ? (
            <p className="muted">Comparing v{pair.a} and v{pair.b}…</p>
          ) : (
            <DiffFilmstrips
              a={{ n: shown.pair.a, snapshot: shown.a, thumbs: thumbsOf(shown.pair.a, shown.a) }}
              b={{ n: shown.pair.b, snapshot: shown.b, thumbs: thumbsOf(shown.pair.b, shown.b) }}
              entries={shown.entries}
              focused={focused}
              onFocus={(id) => setFocused((prev) => (prev === id ? undefined : id))}
            />
          )}
        </section>
        <aside aria-label="what changed" className="history-changes">
          <div className="history-changes-scroll">
            <h2 className="screen-title" style={{ marginBottom: 14 }}>What changed</h2>
            {done && (!shown || shown.a.order.length === 0 || shown.entries.length === 0 || shown.pair.a === shown.pair.b) ? <ol style={{ listStyle: 'none', margin: '0 0 12px', padding: 0 }}>{doneRow(done)}</ol> : null}
            {!shown ? null : shown.pair.a === shown.pair.b ? (
              <p className="muted" style={{ fontSize: 13 }}>Both sides are v{shown.pair.a}. Click another version to compare from it, or shift-click to compare to it.</p>
            ) : shown.entries.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>v{shown.pair.a} and v{shown.pair.b} have the same slides in the same order.</p>
            ) : shown.a.order.length === 0 ? (
              // Every row would remove a slide from main: no per-row buttons for a restore that empties the deck.
              <p className="muted" style={{ fontSize: 13 }}>v{shown.pair.a} is empty: restoring would remove every slide</p>
            ) : (
              <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {withDone(shown.entries.map((e, index) => {
                  const key = `${e.kind}:${e.slide}`;
                  if (done?.key === key) return doneRow(done);
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
                        <span className="muted" data-testid="diff-entry-title" style={{ marginTop: 2, fontSize: 'var(--fs-meta)', lineHeight: '16px', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }} title={d.title}>{d.title}</span>
                        {/* What the button does, in the row itself: a tooltip alone hid that restoring an added slide deletes it. */}
                        <span className="muted" data-testid="diff-entry-does" style={{ display: 'block', marginTop: 2, fontSize: 'var(--fs-meta)', lineHeight: '16px' }}>restore: {does}</span>
                      </span>
                      {confirming === key ? (
                        // Restoring rewrites main: the second click, next to what it does, is the commit.
                        <span data-testid="restore-confirm" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, fontSize: 12 }}>
                          <span>{does}?</span>
                          <span style={{ display: 'flex', gap: 6 }}>
                            <button type="button" className="btn" onClick={() => setConfirming(null)} style={rowButton}>cancel</button>
                            <button type="button" className="btn-primary" onClick={() => restore(e, key, index)} disabled={busy !== null} style={rowButton}>confirm</button>
                          </span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setConfirming(key)}
                          disabled={busy !== null}
                          aria-label={`restore (${does}): ${d.where}, as in v${shown.pair.a}`}
                          title={`${does[0]!.toUpperCase()}${does.slice(1)}, as in v${shown.pair.a}`}
                          style={rowButton}
                        >
                          {busy === key ? 'restoring…' : 'restore'}
                        </button>
                      )}
                    </li>
                  );
                }))}
              </ol>
            )}
          </div>
        </aside>
      </div>
      {shown && pairSlide !== undefined ? (
        <section aria-label="compared slide" style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 24px' }}>
          <ComparePair compared={shown} slide={pairSlide} thumbsA={thumbsOf(shown.pair.a, shown.a)} thumbsB={thumbsOf(shown.pair.b, shown.b)} />
        </section>
      ) : (
        <div style={{ flex: '1 1 0' }} />
      )}
      {/* The version line is a thin rail at the foot of the screen, as on main under the lanes. */}
      <div className="history-rail">
        <div ref={railBox} style={{ position: 'relative' }}>
          <VersionLine versions={versions} current={deck.state.version} selection={pair ?? undefined} onSelect={select} />
          {railChips.map((c) => (
            <button
              key={c.n}
              type="button"
              className="edge-chip"
              data-testid="rail-edge-chip"
              data-side={c.side}
              title={`Scroll the rail to v${c.n}`}
              onClick={() => revealOnRail(c.n)}
              style={{ position: 'absolute', top: -4, zIndex: 4, cursor: 'pointer', ...(c.side === 'left' ? { left: 'calc(var(--gutter) + 6px)' } : { right: 0 }) }}
            >
              {`${c.role} v${c.n}`}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
