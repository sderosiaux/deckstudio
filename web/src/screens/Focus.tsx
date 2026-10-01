import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { Anchor, Change, Lane, Slide, SlideId } from '../../../src/model/types.js';
import {
  focusApi,
  focusPath,
  mainPath,
  navigate as defaultNavigate,
  slidePath,
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
import { anchorColumns, offSlideFields, originTag, type OffSlideField } from '../components/LaneRow.js';
import { describeAnchor } from '../components/ContextChip.js';
import { Thumb } from '../components/Thumb.js';
import { SlidePreview, type SlidePreviewProps } from '../components/SlidePreview.js';
import { TextDiff, plainText } from '../components/TextDiff.js';
import { Thread, type ThreadNote } from '../components/Thread.js';

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

/**
 * Where to go once `changeId` is decided: the next pending change of the lane after it in lane order, else the first
 * one; with none left, the edit screen of the slide it changed when main still has it, else main.
 */
export function pathAfter(lane: Lane, changeId: string, slide: SlideId, mainOrder: readonly SlideId[]): string {
  const pending = pendingOf(lane).filter((c) => c.id !== changeId);
  if (pending.length === 0) return mainOrder.includes(slide) ? slidePath(slide) : '/';
  const pos = lane.changes.findIndex((c) => c.id === changeId);
  const next = pending.find((c) => lane.changes.indexOf(c) > pos) ?? pending[0]!;
  return focusPath(lane.id, next.id);
}

/** Five slides of `order` centred on position `at`, slid inward at the deck ends; fewer when the deck is shorter. */
export function excerpt(order: readonly SlideId[], at: number, size = 5): { start: number; ids: SlideId[] } {
  const start = Math.max(0, Math.min(at - Math.floor(size / 2), order.length - size));
  return { start, ids: order.slice(start, start + size) };
}

/** "from your request on slide 3", "unsolicited, from check: arc, on slides 2–4": where the lane comes from and what it is anchored on. */
export function originLine(lane: Lane, order: SlideId[], slides: Record<SlideId, Slide>): string {
  const on = describeAnchor(lane.anchor, order, slides);
  const tag = originTag(lane.origin);
  return tag ? `${tag}, on ${on}` : `from your request on ${on}`;
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
 * Before/after side by side as long as two 320px cards fit the body, stacked below. SlidePreview has a fixed reading
 * width; inside the pair it takes its column's width (its frame keeps the slide 16:9).
 */
const FOCUS_CSS = `
.focus-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 450px)); justify-content: start; gap: 24px; }
.focus-pair > [data-testid="slide-preview"] { width: 100% !important; flex: none !important; }
`;

/** The decision bar's height: the scroll area pads its scroll-to positions by it, so the bar never sits over what is brought into view. */
export const BAR_HEIGHT = 56;
/** How long the acknowledgement of a decision stays before the screen moves on. */
const ACK_MS = 6000;

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

/** A move as structure: five slides of one side around the moved one, which carries the selection ring. */
function MoveExcerpt({ side, caption, order, slides, at, slide, url }: { side: 'main' | 'lane'; caption: string; order: SlideId[]; slides: Record<SlideId, Slide>; at: number; slide: SlideId; url(id: SlideId): string | undefined }) {
  const { start, ids } = excerpt(order, at);
  return (
    <figure
      data-testid="move-excerpt"
      data-side={side}
      style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 'var(--radius)', background: 'var(--card)', boxShadow: side === 'lane' ? '0 0 0 2px var(--accent), var(--shadow)' : '0 0 0 1px var(--line), var(--shadow)' }}
    >
      <figcaption data-testid="move-caption" style={{ fontSize: 'var(--fs-meta)', lineHeight: '16px', color: 'var(--grey)' }}>
        {caption}
      </figcaption>
      <div role="list" style={{ display: 'flex', gap: 'var(--col-gap)', padding: '4px 4px 6px', ['--thumb-w' as string]: '76px', ['--thumb-h' as string]: 'calc(76px * 9 / 16)' }}>
        {ids.map((id, i) => (
          <div role="listitem" key={id}>
            <Thumb slideId={id} n={start + i + 1} title={slides[id]?.title ?? id} url={url(id)} selected={id === slide} hoverTitle={false} onClick={() => undefined} />
          </div>
        ))}
      </div>
    </figure>
  );
}

/** Scrolls `strip` sideways so `el` sits in its middle, unless `el` already shows whole right of the sticky gutter. */
function bringIntoStrip(strip: HTMLElement, el: HTMLElement): void {
  const box = strip.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const gutter = strip.querySelector('.gutter')?.getBoundingClientRect().right ?? box.left;
  if (r.left >= Math.max(box.left, gutter) && r.right <= box.right) return;
  strip.scrollLeft += r.left + r.width / 2 - (box.left + box.width / 2);
}

type Ack = { changeId: string; text: string; next: string };

/** One change of a lane at reading size: main's slide against the lane's, the reason, the lane's thread, accept or refuse. */
export function Focus({ laneId, changeId, api = focusApi, subscribe = defaultSubscribe, navigate = defaultNavigate }: FocusProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [mainThumbs, setMainThumbs] = useState<Record<SlideId, ThumbStatus>>({});
  // Content each main thumb was fetched for, so a reload only re-requests the thumbs of slides that changed.
  const thumbStamps = useRef<Record<SlideId, string>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // A decision says itself where it was made, then the screen moves on.
  const [ack, setAck] = useState<Ack | null>(null);
  // "the co-author revised this lane", until the creator moves on himself.
  const [notice, setNotice] = useState<string | null>(null);
  // Lines added to the lane thread by this screen (decisions); not stored.
  const [notes, setNotes] = useState<ThreadNote[]>([]);
  const generation = useRef(0);
  const changeRef = useRef(changeId);
  changeRef.current = changeId;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // One WebSocket for the screen; the thread registers here instead of opening its own.
  const listeners = useRef(new Set<(e: BusEvent) => void>());
  const fanout = useCallback((h: (e: BusEvent) => void) => {
    listeners.current.add(h);
    return () => {
      listeners.current.delete(h);
    };
  }, []);

  const reload = useCallback(
    async (cause: 'load' | 'lane' = 'load') => {
      const gen = ++generation.current;
      try {
        const [deck, lane, preview] = await Promise.all([api.getDeck(), api.getLane(laneId), api.getLanePreview(laneId)]);
        if (gen !== generation.current) return;
        setLoad({ status: 'ready', deck, lane, preview });
        // Revised in place: the change on screen was replaced. Follow the lane to its first pending change and say why.
        const first = pendingOf(lane)[0];
        if (cause === 'lane' && first && !lane.changes.some((c) => c.id === changeRef.current)) {
          setNotice('the co-author revised this lane');
          navigateRef.current(focusPath(lane.id, first.id));
        }
        const stamp = (id: SlideId): string => JSON.stringify(deck.slides[id] ?? null);
        const onMain = new Set(deck.order);
        thumbStamps.current = Object.fromEntries(Object.entries(thumbStamps.current).filter(([id]) => onMain.has(id)));
        setMainThumbs((prev) => (Object.keys(prev).every((id) => onMain.has(id)) ? prev : Object.fromEntries(Object.entries(prev).filter(([id]) => onMain.has(id)))));
        // The focused slide first, then the rest left to right: the server renders one thumb at a time.
        // Only slides never fetched, or whose content changed since: a stamp is recorded once its thumb is in,
        // so a fetch cut short by a newer reload is retried by that reload.
        const focused = lane.changes.find((c) => c.id === changeRef.current);
        const head = focused ? targetOf(focused) : null;
        const ids = head && deck.order.includes(head) ? [head, ...deck.order.filter((id) => id !== head)] : deck.order;
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
    },
    [api, laneId],
  );

  useEffect(() => {
    void reload();
    return subscribe((e) => {
      for (const h of listeners.current) h(e);
      if (e.type === 'deck.changed') void reload();
      else if ((e.type === 'lane.updated' || e.type === 'lane.closed') && e.laneId === laneId) void reload('lane');
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

  // The acknowledgement stays ACK_MS, then the screen moves on by itself.
  useEffect(() => {
    if (!ack) return;
    const id = setTimeout(() => {
      setAck(null);
      navigateRef.current(ack.next);
    }, ACK_MS);
    return () => clearTimeout(id);
  }, [ack]);

  const strips = useRef<HTMLElement>(null);
  const visible = useVisibleColumns(strips, '[data-strip="main"] [data-testid="thumb"]', [load.status]);

  // Once per change: the lane strip shows the column where the change lands (a move's destination included).
  const ready = load.status === 'ready';
  const laneAtForScroll = ready ? (() => {
    const c = load.lane.changes.find((x) => x.id === changeId);
    return c ? load.preview.order.indexOf(targetOf(c)) : -1;
  })() : -1;
  useEffect(() => {
    const strip = strips.current;
    if (!strip || laneAtForScroll < 0) return;
    const row = strip.querySelectorAll('[role="list"]')[1];
    const el = row?.children[laneAtForScroll]?.querySelector<HTMLElement>('[data-testid="thumb"]');
    if (el) bringIntoStrip(strip, el);
  }, [changeId, ready, laneAtForScroll]);

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
  // While its acknowledgement shows, the decided change stays on screen.
  const acked = ack && ack.changeId === changeId ? lane.changes.find((c) => c.id === changeId) : undefined;
  const change = index >= 0 ? pending[index]! : acked;
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

  const leave = (path: string): void => {
    setNotice(null);
    navigate(path);
  };

  const decide = async (verb: 'accept' | 'refuse'): Promise<void> => {
    if (!change || !target || acked) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      let text: string;
      let next: string;
      if (verb === 'accept') {
        const res = await api.acceptChange(lane.id, change.id);
        text = `accepted into main as v${res.version.n}`;
        next = pathAfter(res.lane, change.id, target, res.version.order);
      } else {
        const after = await api.refuseChange(lane.id, change.id);
        text = 'refused';
        next = pathAfter(after, change.id, target, deck.order);
      }
      const at = new Date().toISOString();
      setNotes((n) => [...n, { id: `decision-${change.id}`, text, at }]);
      setAck({ changeId: change.id, text, next });
    } catch (err) {
      setActionError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const n = pending.length;
  const prev = index > 0 ? focusPath(lane.id, pending[index - 1]!.id) : null;
  const next = index >= 0 && index < n - 1 ? focusPath(lane.id, pending[index + 1]!.id) : null;
  const firstPending = pending[0] ? focusPath(lane.id, pending[0].id) : null;

  const openSlide = (id: SlideId): void => {
    const c = pending.find((x) => targetOf(x) === id);
    if (c && c.id !== changeId) leave(focusPath(lane.id, c.id));
  };

  let left: SlidePreviewProps | null = null;
  let right: SlidePreviewProps | null = null;
  const skipped = change ? preview.skipped.includes(change.id) : false;
  const mainAt = target ? deck.order.indexOf(target) : -1;
  const laneAt = target ? preview.order.indexOf(target) : -1;
  // A move shows as structure: the slide among its neighbours on each side, not two identical renders.
  const asMove = change?.kind === 'move' && !skipped && mainAt >= 0 && laneAt >= 0 && !acked;
  if (change && target && !asMove) {
    left =
      change.kind === 'insert'
        ? { label: 'main', variant: 'missing', missingText: 'not in main' }
        : mainAt < 0
          ? { label: 'main', variant: 'missing', missingText: 'no longer in main' }
          : { label: `main, slide ${mainAt + 1}`, variant: 'main', title: deck.slides[target]?.title ?? target, url: mainUrl(target) };
    right = skipped
      ? { label: 'this lane', variant: 'missing', missingText: 'no longer applies on main' }
      : change.kind === 'remove' || laneAt < 0
        ? { label: 'this lane', variant: 'missing', missingText: 'removed' }
        : {
            label: `this lane, slide ${laneAt + 1}${change.kind === 'move' && mainAt >= 0 ? ` (was ${mainAt + 1})` : ''}`,
            variant: 'lane',
            title: preview.slides[target]?.title ?? target,
            url: laneUrl(target),
          };
  }

  // Only when main still has the slide: a skipped change has nothing to diff against.
  const texts = change && target && !skipped && !acked ? textChanges(change, deck.slides[target]) : [];

  const sameRender = change && !skipped && !acked ? sameRenderNote(offSlideFields(change)) : null;

  const context: Anchor = target && deck.order.includes(target) ? { kind: 'slide', slide: target } : lane.anchor;
  const step = acked ? 'decided' : change ? `change ${index + 1} of ${n}` : `change – of ${n}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <ScreenHeader>
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h1 data-testid="focus-title" className="screen-title" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
            {lane.label}
          </h1>
          <p style={{ margin: 0, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <span data-testid="focus-origin" className="meta">{originLine(lane, deck.order, deck.slides)}</span>
            <span data-testid="focus-crumb" className="meta" style={{ color: 'var(--ink)' }}>{step}</span>
          </p>
        </div>
        <BackToMain navigate={navigate} style={{ alignSelf: 'flex-start' }} />
      </ScreenHeader>
      {/* One left edge: the body starts on the title's column (24px padding + the 120px gutter), as the strips below. */}
      <main
        data-testid="focus-scroll"
        style={{ flex: 1, minHeight: 0, overflow: 'auto', scrollPaddingBottom: BAR_HEIGHT, padding: '4px 24px 0 calc(24px + var(--gutter))', display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        {notice ? (
          <p data-testid="focus-notice" role="status" style={{ margin: 0, fontSize: 'var(--fs-body)', fontWeight: 500, color: 'var(--ink)' }}>
            {notice}
          </p>
        ) : null}
        {!change ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start', paddingBottom: 24 }}>
            <p style={{ margin: 0 }}>
              {lane.status === 'closed'
                ? 'This lane is closed: all its changes were decided or it was discarded.'
                : `This change is ${lane.changes.find((c) => c.id === changeId)?.status ?? 'no longer part of this lane'}.`}
            </p>
            {firstPending ? (
              <a href={firstPending} onClick={go(firstPending)} className="btn-primary">Review the first pending change</a>
            ) : (
              <a href={mainPath(lane.anchor)} onClick={go(mainPath(lane.anchor))} className="btn-primary">Back to main</a>
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
            {asMove && target ? (
              <div data-testid="focus-pair" className="focus-pair">
                <MoveExcerpt side="main" caption={`main, was ${mainAt + 1}`} order={deck.order} slides={deck.slides} at={mainAt} slide={target} url={mainUrl} />
                <MoveExcerpt side="lane" caption={`this lane, now ${laneAt + 1}`} order={preview.order} slides={preview.slides} at={laneAt} slide={target} url={laneUrl} />
              </div>
            ) : (
              <div data-testid="focus-pair" className="focus-pair">
                {left ? <SlidePreview {...left} /> : null}
                {right ? <SlidePreview {...right} /> : null}
              </div>
            )}
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
          </>
        )}
        <section aria-label="lane thread" style={{ maxWidth: 924, padding: '8px 0 16px', borderTop: '1px solid var(--line)' }}>
          <Thread
            threadKey={`lane:${lane.id}`}
            title="conversation about this lane"
            hint="Your message revises this lane: ask for another wording, another render, or to drop a change."
            context={context}
            order={deck.order}
            slides={deck.slides}
            api={api}
            subscribe={fanout}
            navigate={navigate}
            layout="inline"
            notes={notes}
          />
        </section>
        {actionError ? (
          <p role="alert" style={{ margin: 0, color: 'var(--warn)', fontSize: 13 }}>
            {actionError}
          </p>
        ) : null}
        {change && acked && ack ? (
          <div
            data-testid="decide-ack"
            role="status"
            style={{ position: 'sticky', bottom: 0, marginTop: 'auto', zIndex: 2, height: BAR_HEIGHT, flex: `0 0 ${BAR_HEIGHT}px`, display: 'flex', alignItems: 'center', gap: 20, background: 'var(--paper)', borderTop: '1px solid var(--line)' }}
          >
            <span style={{ fontWeight: 500 }}>{ack.text}</span>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setAck(null);
                leave(ack.next);
              }}
            >
              {ack.next.startsWith('/lane/') ? 'next change' : ack.next.startsWith('/slide/') ? 'back to the slide' : 'back to main'}
            </button>
          </div>
        ) : change ? (
          <div
            data-testid="decide-bar"
            style={{ position: 'sticky', bottom: 0, marginTop: 'auto', zIndex: 2, height: BAR_HEIGHT, flex: `0 0 ${BAR_HEIGHT}px`, display: 'flex', alignItems: 'center', gap: 20, background: 'var(--paper)', borderTop: '1px solid var(--line)' }}
          >
            <button type="button" className="link" style={navBtn} disabled={!prev} onClick={() => prev && leave(prev)}>
              previous change
            </button>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void decide('accept')}>
                accept
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void decide('refuse')}>
                refuse
              </button>
            </div>
            <button type="button" className="link" style={navBtn} disabled={!next} onClick={() => next && leave(next)}>
              next change
            </button>
          </div>
        ) : null}
      </main>
      <div style={{ position: 'relative', flex: '0 0 auto', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--line)' }}>
        <footer ref={strips} className="fit-columns" style={{ background: 'var(--paper)', overflow: 'auto', padding: '14px 24px 14px 24px' }}>
          <div style={{ width: 'max-content', minWidth: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <Filmstrip order={deck.order} slides={deck.slides} thumbs={mainThumbUrls} selected={target ?? undefined} onSelect={openSlide} label="main" />
              <RangeUnderline count={deck.order.length} cols={anchorColumns(lane.anchor, deck.order)} label="this lane's slides on main" />
            </div>
            <div>
              <Filmstrip order={preview.order} slides={preview.slides} thumbs={laneThumbUrls} selected={target ?? undefined} onSelect={openSlide} label="this lane" fullLabel={lane.label} />
              <RangeUnderline count={preview.order.length} cols={laneColumns(lane, preview, deck.order)} label="changed in this lane" />
            </div>
          </div>
        </footer>
        <EdgeFade visible={visible} />
      </div>
    </div>
  );
}
