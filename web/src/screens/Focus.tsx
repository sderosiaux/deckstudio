import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { Anchor, Change, Lane, Slide, SlideId } from '../../../src/model/types.js';
import {
  focusApi,
  focusPath,
  navigate as defaultNavigate,
  subscribe as defaultSubscribe,
  thumbUrl,
  type BusEvent,
  type DeckPayload,
  type FocusApi,
  type LanePreviewPayload,
  type ThumbStatus,
} from '../api.js';
import { EdgeFade, useVisibleColumns } from '../components/EdgeFade.js';
import { BackToMain, ScreenHeader } from '../components/ScreenHeader.js';
import { Filmstrip } from '../components/Filmstrip.js';
import { anchorColumns, offSlideFields, shortLabel, type OffSlideField } from '../components/LaneRow.js';
import { SlidePreview, type SlidePreviewProps } from '../components/SlidePreview.js';
import { TextDiff, plainText } from '../components/TextDiff.js';
import { Thread } from '../components/Thread.js';

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

/** Where to go once `changeId` is decided: the next pending change after it in lane order, else the first one, else main. */
export function pathAfter(lane: Lane, changeId: string): string {
  const pending = pendingOf(lane);
  if (pending.length === 0) return '/';
  const pos = lane.changes.findIndex((c) => c.id === changeId);
  const next = pending.find((c) => lane.changes.indexOf(c) > pos) ?? pending[0]!;
  return focusPath(lane.id, next.id);
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

/** Text fields a modify rewrites, each as before/after lines against main's slide. Empty for other kinds. */
export function textChanges(change: Change, before: Slide | undefined): { field: (typeof TEXT_FIELDS)[number]; before: string[]; after: string[] }[] {
  if (change.kind !== 'modify' || !before) return [];
  const lines = (field: (typeof TEXT_FIELDS)[number], v: string): string[] => (field === 'body' ? plainText(v) : v === '' ? [] : v.split('\n'));
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

/*
 * Before/after side by side from 1280px, stacked below. SlidePreview has a fixed reading width; inside the pair it
 * takes its column's width (its frame keeps the slide 16:9), so both fit next to the thread instead of one falling under the fold.
 */
const FOCUS_CSS = `
.focus-pair { display: grid; grid-template-columns: minmax(0, 450px); justify-content: start; gap: 24px; }
@media (min-width: 1280px) { .focus-pair { grid-template-columns: repeat(2, minmax(0, 450px)); } }
.focus-pair > [data-testid="slide-preview"] { width: 100% !important; flex: none !important; }
`;

const navBtn: CSSProperties = { padding: '8px 0' };

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

/** One change of a lane at reading size: main's slide against the lane's, the reason, accept or refuse, and the lane's thread. */
export function Focus({ laneId, changeId, api = focusApi, subscribe = defaultSubscribe, navigate = defaultNavigate }: FocusProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [mainThumbs, setMainThumbs] = useState<Record<SlideId, ThumbStatus>>({});
  // Content each main thumb was fetched for, so a reload only re-requests the thumbs of slides that changed.
  const thumbStamps = useRef<Record<SlideId, string>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const generation = useRef(0);
  const changeRef = useRef(changeId);
  changeRef.current = changeId;
  // One WebSocket for the screen; the thread registers here instead of opening its own.
  const listeners = useRef(new Set<(e: BusEvent) => void>());
  const fanout = useCallback((h: (e: BusEvent) => void) => {
    listeners.current.add(h);
    return () => {
      listeners.current.delete(h);
    };
  }, []);

  const reload = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const [deck, lane, preview] = await Promise.all([api.getDeck(), api.getLane(laneId), api.getLanePreview(laneId)]);
      if (gen !== generation.current) return;
      setLoad({ status: 'ready', deck, lane, preview });
      const stamp = (id: SlideId): string => JSON.stringify(deck.slides[id] ?? null);
      const onMain = new Set(deck.order);
      thumbStamps.current = Object.fromEntries(Object.entries(thumbStamps.current).filter(([id]) => onMain.has(id)));
      setMainThumbs((prev) => (Object.keys(prev).every((id) => onMain.has(id)) ? prev : Object.fromEntries(Object.entries(prev).filter(([id]) => onMain.has(id)))));
      // The focused slide first, then the rest left to right: the server renders one thumb at a time.
      // Only slides never fetched, or whose content changed since: a stamp is recorded once its thumb is in,
      // so a fetch cut short by a newer reload is retried by that reload.
      const focused = lane.changes.find((c) => c.id === changeRef.current);
      const first = focused ? targetOf(focused) : null;
      const ids = first && deck.order.includes(first) ? [first, ...deck.order.filter((id) => id !== first)] : deck.order;
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
  }, [api, laneId]);

  useEffect(() => {
    void reload();
    return subscribe((e) => {
      for (const h of listeners.current) h(e);
      if (e.type === 'deck.changed') void reload();
      else if ((e.type === 'lane.updated' || e.type === 'lane.closed') && e.laneId === laneId) void reload();
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

  const strips = useRef<HTMLElement>(null);
  const visible = useVisibleColumns(strips, '[data-strip="main"] [data-testid="thumb"]', [load.status]);

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
        <a href="/" onClick={go('/')} className="link">back to main</a>
      </div>
    );
  }

  const { deck, lane, preview } = load;
  const pending = pendingOf(lane);
  const index = pending.findIndex((c) => c.id === changeId);
  const change = index >= 0 ? pending[index]! : undefined;
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

  const run = async (fn: () => Promise<Lane>): Promise<void> => {
    if (!change) return;
    setBusy(true);
    setActionError(null);
    try {
      const next = await fn();
      navigate(pathAfter(next, change.id));
    } catch (err) {
      setActionError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const accept = () => void run(async () => (await api.acceptChange(lane.id, changeId)).lane);
  const refuse = () => void run(() => api.refuseChange(lane.id, changeId));

  const n = pending.length;
  const step = (d: 1 | -1): string | null => {
    if (n === 0) return null;
    if (index < 0) return focusPath(lane.id, pending[0]!.id);
    return focusPath(lane.id, pending[(index + d + n) % n]!.id);
  };
  const prev = step(-1);
  const next = step(1);

  const openSlide = (id: SlideId): void => {
    const c = pending.find((x) => targetOf(x) === id);
    if (c && c.id !== changeId) navigate(focusPath(lane.id, c.id));
  };

  const short = shortLabel(lane.label);
  let left: SlidePreviewProps | null = null;
  let right: SlidePreviewProps | null = null;
  const skipped = change ? preview.skipped.includes(change.id) : false;
  if (change && target) {
    const mainAt = deck.order.indexOf(target);
    const laneAt = preview.order.indexOf(target);
    left =
      change.kind === 'insert'
        ? { label: 'main', variant: 'missing', missingText: 'not in main' }
        : mainAt < 0
          ? { label: 'main', variant: 'missing', missingText: 'no longer in main' }
          : { label: `main, slide ${mainAt + 1}`, variant: 'main', title: deck.slides[target]?.title ?? target, url: mainUrl(target) };
    right = skipped
      ? { label: short, variant: 'missing', missingText: 'no longer applies on main' }
      : change.kind === 'remove' || laneAt < 0
        ? { label: short, variant: 'missing', missingText: 'removed' }
        : {
            label: `${short}, slide ${laneAt + 1}${change.kind === 'move' && mainAt >= 0 ? ` (was ${mainAt + 1})` : ''}`,
            variant: 'lane',
            title: preview.slides[target]?.title ?? target,
            url: laneUrl(target),
          };
  }

  // Only when main still has the slide: a skipped change has nothing to diff against.
  const texts = change && target && !skipped ? textChanges(change, deck.slides[target]) : [];

  const sameRender = change && !skipped ? sameRenderNote(offSlideFields(change)) : null;

  const context: Anchor = target && deck.order.includes(target) ? { kind: 'slide', slide: target } : lane.anchor;

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* The top sizes to the pair, the story and the actions; the filmstrips below take the rest of the height. */}
        <div style={{ flex: '0 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ScreenHeader>
            <h1 data-testid="focus-crumb" className="screen-title" title={lane.label}>
              {short}, change {change ? index + 1 : '–'} of {n}
            </h1>
            <BackToMain navigate={navigate} />
          </ScreenHeader>
          {/* One left edge: the body starts on the title's column (24px padding + the 120px gutter), as the strips below. */}
          <main style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 24px 0 calc(24px + var(--gutter))', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {!change ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
                <p style={{ margin: 0 }}>
                  {lane.status === 'closed'
                    ? 'This lane is closed: all its changes were decided or it was discarded.'
                    : `This change is ${lane.changes.find((c) => c.id === changeId)?.status ?? 'not part of this lane'}.`}
                </p>
                {next ? (
                  <a href={next} onClick={go(next)} className="btn-primary">Review the first pending change</a>
                ) : (
                  <a href="/" onClick={go('/')} className="btn-primary">Back to main</a>
                )}
              </div>
            ) : (
              <>
                <style>{FOCUS_CSS}</style>
                {sameRender ? (
                  <p data-testid="focus-same-render" className="meta" style={{ margin: '0 0 -8px' }}>
                    {sameRender}
                  </p>
                ) : null}
                <div data-testid="focus-pair" className="focus-pair">
                  {left ? <SlidePreview {...left} /> : null}
                  {right ? <SlidePreview {...right} /> : null}
                </div>
                <p data-testid="focus-reason" style={{ margin: 0, display: 'flex', gap: 12, alignItems: 'baseline', fontSize: 13, maxWidth: 924 }}>
                  <span className="meta">{change.kind}</span>
                  <span style={{ color: 'var(--grey)' }}>{change.reason}</span>
                </p>
                {texts.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 924, width: '100%' }}>
                    {texts.map((t) => (
                      <TextDiff key={t.field} label={t.field} before={t.before} after={t.after} />
                    ))}
                  </div>
                ) : null}
                {actionError ? (
                  <p role="alert" style={{ margin: 0, color: 'var(--warn)', fontSize: 13 }}>
                    {actionError}
                  </p>
                ) : null}
                <div
                  data-testid="decide-bar"
                  style={{ position: 'sticky', bottom: 0, marginTop: 8, zIndex: 2, display: 'flex', alignItems: 'center', gap: 20, padding: '0 0 14px', background: 'var(--paper)' }}
                >
                  <button type="button" className="link" style={navBtn} disabled={!prev || n <= 1} onClick={() => prev && navigate(prev)}>
                    previous change
                  </button>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button type="button" className="btn-primary" disabled={busy} onClick={accept}>
                      accept
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={refuse}>
                      refuse
                    </button>
                  </div>
                  <button type="button" className="link" style={navBtn} disabled={!next || n <= 1} onClick={() => next && navigate(next)}>
                    next change
                  </button>
                </div>
              </>
            )}
          </main>
        </div>
        <div style={{ position: 'relative', flex: '1 0 auto', minHeight: 200, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--line)' }}>
          <footer ref={strips} className="fit-columns" style={{ flex: 1, minHeight: 0, background: 'var(--paper)', overflow: 'auto', padding: '14px 24px 14px 24px' }}>
            <div style={{ width: 'max-content', minWidth: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <Filmstrip order={deck.order} slides={deck.slides} thumbs={mainThumbUrls} selected={target ?? undefined} onSelect={openSlide} label="main" />
                <RangeUnderline count={deck.order.length} cols={anchorColumns(lane.anchor, deck.order)} label="this lane's slides on main" />
              </div>
              <div>
                <Filmstrip order={preview.order} slides={preview.slides} thumbs={laneThumbUrls} selected={target ?? undefined} onSelect={openSlide} label={short} fullLabel={lane.label} />
                <RangeUnderline count={preview.order.length} cols={laneColumns(lane, preview, deck.order)} label="changed in this lane" />
              </div>
            </div>
          </footer>
          <EdgeFade visible={visible} />
        </div>
      </div>
      {/* The thread runs the full height, as on main. */}
      <aside style={{ position: 'relative', width: 360, flex: '0 0 360px', borderLeft: '1px solid var(--line)', background: 'var(--paper)', minHeight: 0 }}>
        <div style={{ position: 'absolute', inset: 0 }}>
          <Thread threadKey={`lane:${lane.id}`} subtitle={`lane ${short}`} context={context} order={deck.order} slides={deck.slides} api={api} subscribe={fanout} />
        </div>
      </aside>
    </div>
  );
}
