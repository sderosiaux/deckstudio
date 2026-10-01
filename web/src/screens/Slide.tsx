import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { Anchor, Change, Lane, Remark, SlideId } from '../../../src/model/types.js';
import {
  focusPath,
  getRemarks,
  mainPath,
  openLane,
  remarkApi,
  navigate as defaultNavigate,
  slideApi,
  slidePath,
  subscribe as defaultSubscribe,
  thumbUrl,
  type BusEvent,
  type DeckPayload,
  type LaneApi,
  type LanePreviewPayload,
  type RemarkApi,
  type SlideApi,
  type ThumbStatus,
} from '../api.js';
import { ChangeButtons, settledNote } from '../components/ChangeButtons.js';
import { describeChange, originTag, targetOf, useLaneActions } from '../components/LaneRow.js';
import { RemarkPostIt } from '../components/Remark.js';
import { BackToMain, ScreenHeader } from '../components/ScreenHeader.js';
import { SlidePreview, type SlidePreviewProps } from '../components/SlidePreview.js';
import { TextDiff } from '../components/TextDiff.js';
import { Thread } from '../components/Thread.js';
import { modified, typingIn } from '../keys.js';

/** The slide screen's calls: the slide, its lanes and thread, and the remarks on it. */
export interface SlideScreenApi extends SlideApi, RemarkApi {
  getRemarks(): Promise<Remark[]>;
  openLane(laneId: string): Promise<void>;
}

const defaultApi: SlideScreenApi = { ...slideApi, ...remarkApi, getRemarks, openLane };

/** Where the slide screen (and focus) split into a work column and a 360px side column. */
export const WIDE_QUERY = '(min-width: 1280px)';

/** Whether the window matches `query`, following it as it changes; true where matchMedia is missing (jsdom). */
export function useMediaQuery(query: string): boolean {
  const read = (): boolean => (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(query).matches : true);
  const [match, setMatch] = useState(read);
  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return;
    const mq = globalThis.matchMedia(query);
    const on = (): void => setMatch(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return match;
}

export interface SlideProps {
  slideId: SlideId;
  api?: SlideScreenApi;
  /** Server events; returns the unsubscribe function. */
  subscribe?(handler: (e: BusEvent) => void): () => void;
  navigate?(path: string): void;
}

type DeckLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; deck: DeckPayload };
type LanesLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; lanes: Lane[] };
type RemarksLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; remarks: Remark[]; drafts: ReadonlySet<string> };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The changes of an open lane still to decide on `slideId`. */
const liveOn = (lane: Lane, slideId: SlideId): Change[] =>
  lane.status === 'open' ? lane.changes.filter((c) => c.status === 'pending' && targetOf(c) === slideId) : [];

/** The changes of an open lane the list shows on `slideId`: those to decide, and those the server settled (with why). */
const listedOn = (lane: Lane, slideId: SlideId): Change[] =>
  lane.status === 'open' ? lane.changes.filter((c) => targetOf(c) === slideId && (c.status === 'pending' || settledNote(lane, c) !== null)) : [];

/** Open remarks about this slide on main: anchored on it, or on a range that holds it. */
export function remarksOn(remarks: readonly Remark[], slideId: SlideId, order: readonly SlideId[]): Remark[] {
  const at = order.indexOf(slideId);
  return remarks.filter((r) => {
    if (r.status !== 'open' || r.sourceLaneId) return false;
    if (r.anchor.kind === 'slide') return r.anchor.slide === slideId;
    if (r.anchor.kind !== 'range' || at < 0) return false;
    const [a, b] = [order.indexOf(r.anchor.from), order.indexOf(r.anchor.to)];
    return a >= 0 && b >= 0 && Math.min(a, b) <= at && at <= Math.max(a, b);
  });
}

/**
 * `text` with every whole slide id of `slides` read as the creator reads it: "slide 5, Few decisions need an LLM" for a
 * slide on main, its title for one that is not. Co-author rationales cite ids; the screens never show one.
 */
export function nameSlides(text: string, order: readonly SlideId[], slides: Record<SlideId, { title: string }>): string {
  const ids = Object.keys(slides).sort((a, b) => b.length - a.length);
  if (ids.length === 0) return text;
  const re = new RegExp(`(?<![\\w-])(${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`, 'g');
  return text.replace(re, (id) => {
    const at = order.indexOf(id);
    const title = slides[id]!.title;
    return at < 0 ? title : `slide ${at + 1}, ${title}`;
  });
}

/** Story and notes stay under 80 characters a line: freed width goes to the render, not to longer lines. */
const TEXT_WIDTH = '80ch';
/** The conversation under the render stops growing here and scrolls, following its latest message. */
const THREAD_MAX = 'min(420px, 50vh)';

const HINT = 'Ask for a change to this slide. The co-author answers here, under the render: its proposal shows above, and you accept or refuse it in its reply.';

/** A text field as diff lines: one per line, none for an empty field. */
const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/**
 * One slide's text field under the render, as the render tab shows it: main's text, or the lane's, said to be changed
 * or not; a changed one is a word diff against main.
 */
function Field({ name, main, lane, testId, empty }: { name: string; main: string; lane?: { label: string; text: string } | undefined; testId: string; empty: string }) {
  const text = lane ? lane.text : main;
  const changed = lane !== undefined && lane.text !== main;
  const source = lane ? `in ${lane.label}, ${changed ? 'changed' : 'unchanged'}` : 'on main';
  return (
    <section data-testid={testId} style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: TEXT_WIDTH }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h2 className="meta" style={{ margin: 0, fontWeight: 500, color: 'var(--ink)' }}>{name}</h2>
        <span data-testid="field-source" className="meta">{source}</span>
      </div>
      {changed ? (
        <TextDiff label={name} before={linesOf(main)} after={linesOf(lane.text)} bare />
      ) : (
        <p style={{ margin: 0, fontSize: 'var(--fs-body)', lineHeight: 1.5, whiteSpace: 'pre-wrap', color: text ? 'var(--ink)' : 'var(--grey)' }}>{text || empty}</p>
      )}
    </section>
  );
}

/**
 * One open lane with a change on this slide: its name (a click shows its proposal on the render), and per change the
 * kind and reason, accept, refuse and open in focus. The row of the lane shown on the render is ringed.
 */
function LaneOnSlide({ lane, changes, api, navigate, selected, onShow, describe, readable }: { lane: Lane; changes: Change[]; api: LaneApi; navigate(path: string): void; selected: boolean; onShow(): void; describe(c: Change): string; readable(text: string): string }) {
  const { busy, error, accept, refuse } = useLaneActions(lane.id, api);
  const tag = originTag(lane.origin);
  return (
    <li
      id={`slide-lane-${lane.id}`}
      data-testid="slide-lane"
      data-lane={lane.id}
      aria-current={selected ? 'true' : undefined}
      onClick={onShow}
      className="slide-lane"
    >
      <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 12, rowGap: 2 }}>
        <button
          type="button"
          className="link row-label"
          style={{ fontSize: 'var(--fs-row)', color: 'var(--ink)', whiteSpace: 'normal' }}
          onClick={(e) => {
            e.stopPropagation();
            onShow();
          }}
        >
          {lane.label}
        </button>
        {tag ? <span className="meta">{tag}</span> : null}
      </div>
      {changes.map((c) => {
        const href = focusPath(lane.id, c.id);
        const settled = settledNote(lane, c);
        return (
          <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <p style={{ margin: 0, color: 'var(--grey)', fontSize: 'var(--fs-body)', lineHeight: 1.4 }}>
              <span className="meta" style={{ marginRight: 8 }}>{c.kind}</span>
              {readable(c.reason)}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {settled ? (
                <span data-testid="change-settled" className="meta" style={{ color: 'var(--ink)' }}>
                  {settled}
                </span>
              ) : (
                <ChangeButtons change={c} disabled={busy} onAccept={accept} onRefuse={refuse} describe={describe(c)} />
              )}
              <a
                href={href}
                className="link"
                style={{ whiteSpace: 'nowrap' }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  navigate(href);
                }}
              >
                open in focus
              </a>
            </div>
          </div>
        );
      })}
      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * One slide of main, to change it by talking to the co-author. The conversation lives where the slide is: under the
 * render (main's, or a lane's proposal), its replies carrying their proposals, then story and notes as the tab shows
 * them. From 1280px a side column lists the open lanes that change the slide and its remarks; narrower, they follow.
 */
export function Slide({ slideId, api = defaultApi, subscribe = defaultSubscribe, navigate = defaultNavigate }: SlideProps) {
  const wide = useMediaQuery(WIDE_QUERY);
  const [remarksLoad, setRemarksLoad] = useState<RemarksLoad>({ status: 'loading' });
  const remarksGen = useRef(0);
  const bodyRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const [deckLoad, setDeckLoad] = useState<DeckLoad>({ status: 'loading' });
  const [lanesLoad, setLanesLoad] = useState<LanesLoad>({ status: 'loading' });
  const [thumb, setThumb] = useState<ThumbStatus | null>(null);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const thumbHash = useRef<string | null>(null);
  thumbHash.current = thumb?.hash ?? null;
  // Which render the stage shows: main's, or the preview of one lane that changes this slide.
  const [view, setView] = useState<'main' | string>('main');
  const [previews, setPreviews] = useState<Record<string, LanePreviewPayload>>({});
  const deckGen = useRef(0);
  const lanesGen = useRef(0);
  const slideRef = useRef(slideId);
  slideRef.current = slideId;
  // One WebSocket for the screen; the thread registers here instead of opening its own.
  const listeners = useRef(new Set<(e: BusEvent) => void>());
  const fanout = useCallback((h: (e: BusEvent) => void) => {
    listeners.current.add(h);
    return () => {
      listeners.current.delete(h);
    };
  }, []);

  const reloadDeck = useCallback(async () => {
    const gen = ++deckGen.current;
    try {
      const deck = await api.getDeck();
      if (gen === deckGen.current) setDeckLoad({ status: 'ready', deck });
    } catch (err) {
      if (gen === deckGen.current) setDeckLoad({ status: 'error', message: message(err) });
    }
  }, [api]);

  // Lanes a lane.created announced, until a lane list holds them: whichever reload lands first names them.
  const announced = useRef(new Set<string>());

  const reloadLanes = useCallback(async () => {
    const gen = ++lanesGen.current;
    try {
      const lanes = await api.getLanes();
      if (gen !== lanesGen.current) return;
      setLanesLoad({ status: 'ready', lanes });
      // A new lane that changes this slide is what the creator waits for: the stage shows its proposal.
      for (const lane of lanes) {
        if (!announced.current.delete(lane.id)) continue;
        if (liveOn(lane, slideRef.current).length > 0) setView(lane.id);
      }
      // Each lane that changes this slide brings its preview, for the stage's proposed render.
      const here = lanes.filter((l) => liveOn(l, slideRef.current).length > 0);
      // A preview that fails leaves that lane's proposed render out; the lane rows still show.
      const loaded = await Promise.all(here.map((l) => api.getLanePreview(l.id).then((p) => [[l.id, p] as const], () => [])));
      if (gen !== lanesGen.current) return;
      setPreviews(Object.fromEntries(loaded.flat()));
    } catch (err) {
      if (gen === lanesGen.current) setLanesLoad({ status: 'error', message: message(err) });
    }
  }, [api]);

  // Remarks, with the draft lanes some of them link to (a check proposed them; the card offers to open them).
  const reloadRemarks = useCallback(async () => {
    const gen = ++remarksGen.current;
    try {
      const [remarks, drafts] = await Promise.all([api.getRemarks(), api.getLanes('draft')]);
      if (gen === remarksGen.current) setRemarksLoad({ status: 'ready', remarks, drafts: new Set(drafts.map((l) => l.id)) });
    } catch (err) {
      if (gen === remarksGen.current) setRemarksLoad({ status: 'error', message: message(err) });
    }
  }, [api]);

  useEffect(() => {
    void reloadDeck();
    void reloadLanes();
    void reloadRemarks();
    return subscribe((e) => {
      for (const h of listeners.current) h(e);
      if (e.type === 'deck.changed') {
        void reloadDeck();
        void reloadLanes();
      } else if (e.type === 'remarks.changed') {
        void reloadRemarks();
      } else if (e.type === 'lane.created' || e.type === 'lane.updated' || e.type === 'lane.closed') {
        if (e.type === 'lane.created') announced.current.add(e.laneId);
        void reloadLanes();
        void reloadRemarks();
      }
      else if (e.type === 'thumb.ready') {
        setThumb((t) => (t && t.hash === e.hash && !t.ready ? { hash: t.hash, ready: true } : t));
        setPreviews((prev) => {
          let hit = false;
          const next = Object.fromEntries(
            Object.entries(prev).map(([id, p]) => {
              const ids = Object.keys(p.thumbs).filter((x) => p.thumbs[x]!.hash === e.hash && !p.thumbs[x]!.ready);
              if (ids.length === 0) return [id, p];
              hit = true;
              return [id, { ...p, thumbs: { ...p.thumbs, ...Object.fromEntries(ids.map((x) => [x, { hash: e.hash, ready: true }])) } }];
            }),
          );
          return hit ? next : prev;
        });
      }
      else if (e.type === 'thumb.failed' && e.hash === thumbHash.current) setThumbError(e.message);
    });
  }, [reloadDeck, reloadLanes, reloadRemarks, subscribe]);

  // Every slide opens at the top of its columns, the tabs and the whole render in view.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    if (sideRef.current) sideRef.current.scrollTop = 0;
  }, [slideId]);

  // The stage starts on main for every slide; another slide needs the previews of its own lanes.
  const firstSlide = useRef(true);
  useEffect(() => {
    setView('main');
    if (firstSlide.current) {
      firstSlide.current = false;
      return;
    }
    void reloadLanes();
  }, [slideId, reloadLanes]);

  const deck = deckLoad.status === 'ready' ? deckLoad.deck : null;
  const slide = deck && deck.order.includes(slideId) ? deck.slides[slideId] : undefined;
  // The render follows the slide's content: a new slide, or this one changed on main, asks for its thumbnail again.
  const stamp = slide ? JSON.stringify(slide) : null;
  useEffect(() => {
    if (stamp === null) return;
    let live = true;
    setThumb(null);
    setThumbError(null);
    api.thumbFor(slideId).then(
      (t) => live && setThumb(t),
      (err: unknown) => live && setThumbError(message(err)),
    );
    return () => {
      live = false;
    };
  }, [api, slideId, stamp]);

  const at = deck ? deck.order.indexOf(slideId) : -1;
  const prev = deck && at > 0 ? deck.order[at - 1]! : null;
  const next = deck && at >= 0 && at < deck.order.length - 1 ? deck.order[at + 1]! : null;

  // Arrows step through the deck, Escape goes back to main on this slide; never while typing. One listener for the
  // screen's life, reading the neighbours of the slide on screen now: a key pressed right after a render is never stale.
  const keys = useRef({ prev, next, slideId, navigate });
  keys.current = { prev, next, slideId, navigate };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || modified(e) || e.shiftKey || typingIn(e.target)) return;
      const k = keys.current;
      const to = e.key === 'ArrowLeft' ? k.prev && slidePath(k.prev) : e.key === 'ArrowRight' ? k.next && slidePath(k.next) : e.key === 'Escape' ? mainPath({ kind: 'slide', slide: k.slideId }) : null;
      if (!to) return;
      e.preventDefault();
      k.navigate(to);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const go = (path: string) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(path);
  };

  if (deckLoad.status === 'loading') return <div style={{ padding: 32 }} className="muted">Loading slide…</div>;
  if (deckLoad.status === 'error') {
    return (
      <div style={{ padding: 32 }}>
        <p style={{ color: 'var(--warn)', fontWeight: 700 }}>Could not load the deck.</p>
        <p className="muted mono">{deckLoad.message}</p>
        <button type="button" className="btn" onClick={() => void reloadDeck()}>Retry</button>{' '}
        <a href="/" onClick={go('/')} className="link">back to main</a>
      </div>
    );
  }
  if (!slide || !deck) {
    return (
      <div style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
        <p style={{ margin: 0 }}>This slide is no longer on main: a change removed it, or the link is out of date.</p>
        <a href="/" onClick={go('/')} className="link">back to main</a>
      </div>
    );
  }

  const context: Anchor = { kind: 'slide', slide: slideId };
  // Lanes listed on this slide; only those with a change still to decide have a render tab.
  const listed = lanesLoad.status === 'ready' ? lanesLoad.lanes.map((lane) => ({ lane, changes: listedOn(lane, slideId) })).filter((r) => r.changes.length > 0) : [];
  const rows = listed.map((r) => ({ lane: r.lane, changes: liveOn(r.lane, slideId) })).filter((r) => r.changes.length > 0);
  const stepLink = (to: SlideId | null, text: string) =>
    to ? (
      <a href={slidePath(to)} onClick={go(slidePath(to))} className="link">
        {text}
      </a>
    ) : (
      <span className="link" aria-disabled="true" style={{ opacity: 0.4, cursor: 'default' }}>
        {text}
      </span>
    );

  const shown = rows.find((r) => r.lane.id === view);
  const proposal = shown ? previews[shown.lane.id] : undefined;
  const mainUrl = thumb?.ready ? thumbUrl(thumb.hash) : undefined;
  // Lanes that delete this slide: main's render says so, where the change applies.
  const removing = rows.filter((r) => r.changes.some((c) => c.kind === 'remove')).map((r) => r.lane.label);
  let stage: SlidePreviewProps = {
    label: `main, slide ${at + 1}`,
    variant: 'main',
    title: slide.title,
    url: mainUrl,
    overlay: removing.length === 0 ? undefined : removing.length === 1 ? `removed in lane ${removing[0]}` : `removed in lanes ${removing.join(', ')}`,
  };
  if (shown) {
    const laneAt = proposal ? proposal.order.indexOf(slideId) : -1;
    const own = proposal?.thumbs[slideId];
    const label = `proposed in ${shown.lane.label}`;
    stage =
      proposal && laneAt < 0
        ? { label, variant: 'missing', missingText: 'this lane removes the slide' }
        : {
            label: proposal && laneAt !== at ? `${label}, slide ${laneAt + 1} (was ${at + 1})` : label,
            variant: 'lane',
            title: proposal?.slides[slideId]?.title ?? slide.title,
            // A slide the lane only moves keeps main's render; until the preview is in, the title stands in.
            url: proposal ? (own ? (own.ready ? thumbUrl(own.hash) : undefined) : mainUrl) : undefined,
          };
  }

  const render = (
    <>
      {rows.length > 0 ? (
        <div data-testid="slide-toggle" role="group" aria-label="render shown" className="slide-toggle">
          <button type="button" aria-pressed={!shown} onClick={() => setView('main')}>
            main
          </button>
          {rows.map((r) => (
            <button key={r.lane.id} type="button" aria-pressed={shown?.lane.id === r.lane.id} title={r.lane.label} onClick={() => setView(r.lane.id)}>
              proposed in {r.lane.label}
            </button>
          ))}
        </div>
      ) : null}
      <div data-testid="slide-stage" className="slide-stage">
        <SlidePreview {...stage} />
      </div>
      {thumbError && !shown ? (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>
          Could not render this slide: {thumbError}
        </p>
      ) : null}
    </>
  );

  const showLane = (laneId: string): void => {
    setView(laneId);
    document.getElementById(`slide-lane-${laneId}`)?.scrollIntoView?.({ block: 'nearest' });
  };

  const lanesSection = (
    <section data-testid="slide-lanes" aria-label="lanes on this slide" className="slide-section">
      <h2 className="row-label" style={{ margin: 0 }}>lanes on this slide</h2>
      {lanesLoad.status === 'loading' ? (
        <p className="meta" style={{ margin: 0 }}>Loading lanes…</p>
      ) : lanesLoad.status === 'error' ? (
        <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-body)', color: 'var(--warn)' }}>
          <span>Lanes: {lanesLoad.message}</span>{' '}
          <button type="button" className="btn" onClick={() => void reloadLanes()}>Retry</button>
        </p>
      ) : listed.length === 0 ? (
        <p data-testid="slide-lanes-empty" className="muted" style={{ margin: 0, fontSize: 'var(--fs-body)', lineHeight: 1.5 }}>
          No open lane changes this slide. Ask the co-author in the conversation: its lane lands here and on the render.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {listed.map((r) => (
            <LaneOnSlide
              key={r.lane.id}
              lane={r.lane}
              changes={r.changes}
              api={api}
              navigate={navigate}
              selected={shown?.lane.id === r.lane.id}
              onShow={() => setView(r.lane.id)}
              describe={(c) => describeChange(c, deck.order, previews[r.lane.id])}
              readable={(text) => nameSlides(text, deck.order, { ...previews[r.lane.id]?.slides, ...deck.slides })}
            />
          ))}
        </ul>
      )}
    </section>
  );

  const here = remarksLoad.status === 'ready' ? remarksOn(remarksLoad.remarks, slideId, deck.order) : [];
  const openLanes = lanesLoad.status === 'ready' ? lanesLoad.lanes : [];
  const remarksSection = (
    <section data-testid="slide-remarks" aria-label="remarks on this slide" className="slide-section">
      <h2 className="row-label" style={{ margin: 0 }}>remarks on this slide</h2>
      {remarksLoad.status === 'loading' ? (
        <p className="meta" style={{ margin: 0 }}>Loading remarks…</p>
      ) : remarksLoad.status === 'error' ? (
        <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-body)', color: 'var(--warn)' }}>
          <span>Remarks: {remarksLoad.message}</span>{' '}
          <button type="button" className="btn" onClick={() => void reloadRemarks()}>Retry</button>
        </p>
      ) : here.length === 0 ? (
        <p data-testid="slide-remarks-empty" className="muted" style={{ margin: 0, fontSize: 'var(--fs-body)', lineHeight: 1.5 }}>
          No open remark on this slide. The checks on the brief screen add them.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {here.map((r) => {
            const lane = r.laneId ? openLanes.find((l) => l.id === r.laneId) : undefined;
            return (
              <RemarkPostIt
                key={r.id}
                remark={r}
                onPropose={api.proposeRemark}
                onResolve={api.resolveRemark}
                draftLaneId={r.laneId && remarksLoad.drafts.has(r.laneId) ? r.laneId : undefined}
                onOpenLane={api.openLane}
                openedLane={lane ? { label: lane.label, onShow: () => showLane(lane.id) } : undefined}
              />
            );
          })}
        </div>
      )}
    </section>
  );

  const thread = (
    <Thread
      threadKey={`slide:${slideId}`}
      title="conversation about this slide"
      hint={HINT}
      context={context}
      order={deck.order}
      slides={deck.slides}
      api={api}
      subscribe={fanout}
      navigate={navigate}
      layout="inline"
      logMaxHeight={THREAD_MAX}
    />
  );

  // A click on a proposal card (not on its buttons or links) shows that lane's proposal on the render.
  const onTalkClick = (e: MouseEvent): void => {
    const target = e.target as Element;
    if (target.closest('button, a, input')) return;
    const laneId = target.closest('[data-testid="thread-proposal"]')?.getAttribute('data-lane');
    if (laneId && rows.some((r) => r.lane.id === laneId)) setView(laneId);
  };

  const talk = (
    <section aria-label="conversation about this slide" data-testid="slide-talk" className="slide-section" onClick={onTalkClick}>
      {thread}
    </section>
  );

  // On a lane's tab, story and notes are the lane's (its preview of this slide), compared with main's.
  const laneSlide = shown ? proposal?.slides[slideId] : undefined;
  const laneText = (field: 'story' | 'notes') => (shown && laneSlide ? { label: shown.lane.label, text: laneSlide[field] } : undefined);
  const text = (
    <>
      <Field name="story" main={slide.story} lane={laneText('story')} testId="slide-story" empty="No story yet: ask the co-author to write the message this slide carries." />
      <Field name="notes" main={slide.notes} lane={laneText('notes')} testId="slide-notes" empty="No speaker notes yet." />
    </>
  );

  return (
    <div className="slide-screen" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <ScreenHeader>
        <h1 data-testid="slide-crumb" className="screen-title" title={slide.title} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          slide {at + 1} of {deck.order.length}, {slide.title}
        </h1>
        {stepLink(prev, 'previous slide')}
        {stepLink(next, 'next slide')}
        <BackToMain navigate={navigate} />
      </ScreenHeader>
      <div data-testid="slide-layout" className="slide-layout" data-columns={wide ? '2' : '1'}>
        {/* The work column starts on the title's left edge, 24px in: no empty gutter, the render takes that width. */}
        {/* Wide, the work column is the render at the height the conversation under it leaves, nothing else: the text
            the render cannot show (story, notes) reads in the side column, under the lanes and remarks, so neither
            column ends in a band of paper. Narrow, one column in reading order. */}
        <main ref={bodyRef} data-testid="slide-body" className="slide-main">
          <div data-testid="slide-work" className="slide-work">
            {render}
            {talk}
          </div>
          {wide ? null : (
            <>
              <div data-testid="slide-text" className="slide-text">
                {text}
              </div>
              {lanesSection}
              {remarksSection}
            </>
          )}
        </main>
        {wide ? (
          <div data-testid="slide-side" className="slide-side">
            <div ref={sideRef} data-testid="slide-side-scroll" className="slide-side-scroll">
              {lanesSection}
              {remarksSection}
              <div data-testid="slide-text" className="slide-text">
                {text}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
