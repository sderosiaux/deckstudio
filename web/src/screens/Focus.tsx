import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { Anchor, Change, Lane, SlideId } from '../../../src/model/types.js';
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
import { Filmstrip } from '../components/Filmstrip.js';
import { anchorColumns } from '../components/LaneRow.js';
import { SlidePreview, type SlidePreviewProps } from '../components/SlidePreview.js';
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

const navBtn = (disabled: boolean): CSSProperties => ({
  all: 'unset',
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.4 : 1,
  fontSize: 14,
  color: 'var(--ink)',
  padding: '8px 4px',
  transition: 'color .15s ease',
});
const decide = (primary: boolean, disabled: boolean): CSSProperties => ({
  padding: '10px 18px',
  borderRadius: 8,
  border: primary ? 'none' : '1px solid var(--line)',
  background: primary ? 'var(--accent)' : 'var(--card)',
  color: primary ? 'var(--card)' : 'var(--ink)',
  fontWeight: primary ? 700 : 500,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.6 : 1,
  transition: 'opacity .15s ease, border-color .15s ease',
});

function RangeUnderline({ count, cols }: { count: number; cols: { start: number; span: number } | null }) {
  if (!cols) return null;
  return (
    <div style={{ display: 'flex' }}>
      <div style={{ width: 120, flex: '0 0 120px' }} />
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(count, 1)}, var(--thumb-w))`, columnGap: 'var(--col-gap)', padding: '0 6px' }}>
        <div data-testid="range-underline" style={{ gridColumn: `${cols.start + 1} / span ${cols.span}`, height: 3, borderRadius: 2, background: 'var(--accent)' }} />
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
        <button type="button" onClick={() => void reload()}>Retry</button>{' '}
        <a href="/" onClick={go('/')}>back to main</a>
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
          : { label: `main · slide ${mainAt + 1}`, variant: 'main', title: deck.slides[target]?.title ?? target, url: mainUrl(target) };
    right = skipped
      ? { label: lane.label, variant: 'missing', missingText: 'no longer applies on main' }
      : change.kind === 'remove' || laneAt < 0
        ? { label: lane.label, variant: 'missing', missingText: 'removed' }
        : {
            label: `${lane.label} · slide ${laneAt + 1}${change.kind === 'move' && mainAt >= 0 ? ` (was ${mainAt + 1})` : ''}`,
            variant: 'lane',
            title: preview.slides[target]?.title ?? target,
            url: laneUrl(target),
          };
  }

  const context: Anchor = target && deck.order.includes(target) ? { kind: 'slide', slide: target } : lane.anchor;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '16px 24px', borderBottom: '1px solid var(--line)' }}>
        <a href="/" onClick={go('/')} style={{ color: 'var(--grey)', textDecoration: 'none', fontSize: 13 }}>← main</a>
        <h1 data-testid="focus-crumb" style={{ margin: 0, fontSize: 18 }}>
          lane {lane.label} <span className="muted" style={{ fontWeight: 500 }}>· change {change ? index + 1 : '–'} of {n}</span>
        </h1>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <main style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!change ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
              <p style={{ margin: 0 }}>
                {lane.status === 'closed'
                  ? 'This lane is closed: all its changes were decided or it was discarded.'
                  : `This change is ${lane.changes.find((c) => c.id === changeId)?.status ?? 'not part of this lane'}.`}
              </p>
              {next ? (
                <a href={next} onClick={go(next)} style={{ color: 'var(--accent)', fontWeight: 700 }}>review the first pending change →</a>
              ) : (
                <a href="/" onClick={go('/')} style={{ color: 'var(--accent)', fontWeight: 700 }}>back to main →</a>
              )}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                {left ? <SlidePreview {...left} /> : null}
                {right ? <SlidePreview {...right} /> : null}
              </div>
              <p data-testid="focus-reason" style={{ margin: 0, textAlign: 'center', color: 'var(--grey)', fontSize: 14 }}>
                {change.kind}: {change.reason}
              </p>
              {actionError ? (
                <p role="alert" style={{ margin: 0, textAlign: 'center', color: 'var(--warn)', fontSize: 13 }}>
                  {actionError}
                </p>
              ) : null}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                <button type="button" style={navBtn(!prev || n <= 1)} disabled={!prev || n <= 1} onClick={() => prev && navigate(prev)}>
                  ← prev change
                </button>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="button" disabled={busy} onClick={accept} style={decide(true, busy)}>
                    accept this change
                  </button>
                  <button type="button" disabled={busy} onClick={refuse} style={decide(false, busy)}>
                    refuse
                  </button>
                </div>
                <button type="button" style={navBtn(!next || n <= 1)} disabled={!next || n <= 1} onClick={() => next && navigate(next)}>
                  next change →
                </button>
              </div>
            </>
          )}
        </main>
        <aside style={{ width: 360, flex: '0 0 360px', borderLeft: '1px solid var(--line)', background: 'var(--paper)', minHeight: 0 }}>
          <Thread
            threadKey={`lane:${lane.id}`}
            title={`thread · ${lane.label}`}
            context={context}
            order={deck.order}
            slides={deck.slides}
            api={api}
            subscribe={fanout}
          />
        </aside>
      </div>
      <footer style={{ borderTop: '1px solid var(--line)', background: 'var(--paper)', overflow: 'auto', maxHeight: '40%', padding: '14px 24px' }}>
        <div style={{ width: 'max-content', minWidth: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Filmstrip order={deck.order} slides={deck.slides} thumbs={mainThumbUrls} selected={target ?? undefined} onSelect={openSlide} label="main" />
            <RangeUnderline count={deck.order.length} cols={anchorColumns(lane.anchor, deck.order)} />
          </div>
          <div>
            <Filmstrip order={preview.order} slides={preview.slides} thumbs={laneThumbUrls} selected={target ?? undefined} onSelect={openSlide} label={lane.label} />
            <RangeUnderline count={preview.order.length} cols={laneColumns(lane, preview, deck.order)} />
          </div>
        </div>
      </footer>
    </div>
  );
}
