import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Anchor, Change, Lane, SlideId } from '../../../src/model/types.js';
import {
  focusPath,
  mainPath,
  navigate as defaultNavigate,
  slideApi,
  slidePath,
  subscribe as defaultSubscribe,
  thumbUrl,
  type BusEvent,
  type DeckPayload,
  type LaneApi,
  type SlideApi,
  type ThumbStatus,
} from '../api.js';
import { ChangeButtons } from '../components/ChangeButtons.js';
import { originTag, targetOf, useLaneActions } from '../components/LaneRow.js';
import { BackToMain, ScreenHeader } from '../components/ScreenHeader.js';
import { SlidePreview } from '../components/SlidePreview.js';
import { Thread } from '../components/Thread.js';
import { modified, typingIn } from '../keys.js';

export interface SlideProps {
  slideId: SlideId;
  api?: SlideApi;
  /** Server events; returns the unsubscribe function. */
  subscribe?(handler: (e: BusEvent) => void): () => void;
  navigate?(path: string): void;
}

type DeckLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; deck: DeckPayload };
type LanesLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; lanes: Lane[] };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The changes of an open lane still to decide on `slideId`. */
const liveOn = (lane: Lane, slideId: SlideId): Change[] =>
  lane.status === 'open' ? lane.changes.filter((c) => c.status === 'pending' && targetOf(c) === slideId) : [];

/* The slide at reading size on the body column: SlidePreview has a fixed width, here it takes the stage's. */
const SLIDE_CSS = `
.slide-stage { width: min(100%, 800px); }
.slide-stage > [data-testid="slide-preview"] { width: 100% !important; flex: none !important; }
`;
const TEXT_WIDTH = 800;

const HINT = 'Ask for a change to this slide. When it needs other slides or the narrative, the co-author says so and anchors its lane there.';

/** One slide's text field under the render: its name, then the text as written. */
function Field({ name, text, testId, empty }: { name: string; text: string; testId: string; empty: string }) {
  return (
    <section data-testid={testId} style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: TEXT_WIDTH }}>
      <h2 className="meta" style={{ margin: 0, fontWeight: 500 }}>{name}</h2>
      <p style={{ margin: 0, fontSize: 'var(--fs-body)', lineHeight: 1.5, whiteSpace: 'pre-wrap', color: text ? 'var(--ink)' : 'var(--grey)' }}>{text || empty}</p>
    </section>
  );
}

/** One open lane with a change on this slide: its name, and per change the kind, the reason, accept, refuse and focus. */
function LaneOnSlide({ lane, changes, api, navigate }: { lane: Lane; changes: Change[]; api: LaneApi; navigate(path: string): void }) {
  const { busy, error, accept, refuse } = useLaneActions(lane.id, api);
  const tag = originTag(lane.origin);
  return (
    <li data-testid="slide-lane" data-lane={lane.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 0', borderTop: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span className="row-label">{lane.label}</span>
        {tag ? <span className="meta">{tag}</span> : null}
      </div>
      {changes.map((c) => {
        const href = focusPath(lane.id, c.id);
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="meta" style={{ flex: '0 0 48px' }}>{c.kind}</span>
            <span style={{ flex: 1, minWidth: 0, color: 'var(--grey)', fontSize: 'var(--fs-body)', lineHeight: 1.4 }}>{c.reason}</span>
            <ChangeButtons change={c} disabled={busy} onAccept={accept} onRefuse={refuse} />
            <a
              href={href}
              className="link"
              style={{ whiteSpace: 'nowrap' }}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                navigate(href);
              }}
            >
              open in focus
            </a>
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
 * One slide of main, to change it by talking to the co-author: the slide large with its story and notes, the open
 * lanes that change it, and the `slide:<id>` thread. The co-author picks the scope and answers with a lane.
 */
export function Slide({ slideId, api = slideApi, subscribe = defaultSubscribe, navigate = defaultNavigate }: SlideProps) {
  const [deckLoad, setDeckLoad] = useState<DeckLoad>({ status: 'loading' });
  const [lanesLoad, setLanesLoad] = useState<LanesLoad>({ status: 'loading' });
  const [thumb, setThumb] = useState<ThumbStatus | null>(null);
  const [thumbError, setThumbError] = useState<string | null>(null);
  const thumbHash = useRef<string | null>(null);
  thumbHash.current = thumb?.hash ?? null;
  const [ready, setReady] = useState<string | null>(null);
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
      for (const lane of lanes) {
        if (!announced.current.delete(lane.id)) continue;
        if (lane.anchor.kind === 'slide' && lane.anchor.slide === slideRef.current) setReady(lane.label);
      }
    } catch (err) {
      if (gen === lanesGen.current) setLanesLoad({ status: 'error', message: message(err) });
    }
  }, [api]);

  useEffect(() => {
    void reloadDeck();
    void reloadLanes();
    return subscribe((e) => {
      for (const h of listeners.current) h(e);
      if (e.type === 'deck.changed') {
        void reloadDeck();
        void reloadLanes();
      } else if (e.type === 'lane.created' || e.type === 'lane.updated' || e.type === 'lane.closed') {
        if (e.type === 'lane.created') announced.current.add(e.laneId);
        void reloadLanes();
      }
      else if (e.type === 'thumb.ready') setThumb((t) => (t && t.hash === e.hash && !t.ready ? { hash: t.hash, ready: true } : t));
      else if (e.type === 'thumb.failed' && e.hash === thumbHash.current) setThumbError(e.message);
    });
  }, [reloadDeck, reloadLanes, subscribe]);

  // The note belongs to the slide it was announced on.
  useEffect(() => setReady(null), [slideId]);

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

  // Arrows step through the deck, Escape goes back to main on this slide; never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || modified(e) || e.shiftKey || typingIn(e.target)) return;
      const to = e.key === 'ArrowLeft' ? prev && slidePath(prev) : e.key === 'ArrowRight' ? next && slidePath(next) : e.key === 'Escape' ? mainPath({ kind: 'slide', slide: slideId }) : null;
      if (!to) return;
      e.preventDefault();
      navigate(to);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [prev, next, slideId, navigate]);

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
  const rows = lanesLoad.status === 'ready' ? lanesLoad.lanes.map((lane) => ({ lane, changes: liveOn(lane, slideId) })).filter((r) => r.changes.length > 0) : [];
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

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <ScreenHeader>
          <h1 data-testid="slide-crumb" className="screen-title" title={slide.title} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            slide {at + 1} of {deck.order.length}, {slide.title}
          </h1>
          {stepLink(prev, 'previous slide')}
          {stepLink(next, 'next slide')}
          <BackToMain navigate={navigate} />
        </ScreenHeader>
        {/* One left edge: the body starts on the title's column (24px padding + the 120px gutter). */}
        <main style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 24px 32px calc(24px + var(--gutter))', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <style>{SLIDE_CSS}</style>
          <div className="slide-stage">
            <SlidePreview label={`main, slide ${at + 1}`} variant="main" title={slide.title} url={thumb?.ready ? thumbUrl(thumb.hash) : undefined} />
          </div>
          {thumbError ? (
            <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>
              Could not render this slide: {thumbError}
            </p>
          ) : null}
          <Field name="story" text={slide.story} testId="slide-story" empty="No story yet: ask the co-author to write the message this slide carries." />
          <Field name="notes" text={slide.notes} testId="slide-notes" empty="No speaker notes yet." />
          <section aria-label="lanes on this slide" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: TEXT_WIDTH, marginTop: 8 }}>
            {ready ? (
              <p role="status" style={{ margin: 0, display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--fs-body)' }}>
                <span data-testid="lane-ready" style={{ color: 'var(--ink)', fontWeight: 500 }}>lane ready: {ready}</span>
                <button type="button" aria-label="dismiss" className="link" onClick={() => setReady(null)} style={{ fontSize: 12 }}>
                  ×
                </button>
              </p>
            ) : null}
            <h2 className="row-label" style={{ margin: 0 }}>lanes on this slide</h2>
            {lanesLoad.status === 'loading' ? (
              <p className="meta" style={{ margin: 0 }}>Loading lanes…</p>
            ) : lanesLoad.status === 'error' ? (
              <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-body)', color: 'var(--warn)' }}>
                <span>Lanes: {lanesLoad.message}</span>{' '}
                <button type="button" className="btn" onClick={() => void reloadLanes()}>Retry</button>
              </p>
            ) : rows.length === 0 ? (
              <p data-testid="slide-lanes-empty" className="muted" style={{ margin: 0, fontSize: 'var(--fs-body)', lineHeight: 1.5 }}>
                No open lane changes this slide. Ask the co-author on the right; its lane shows up here.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {rows.map((r) => (
                  <LaneOnSlide key={r.lane.id} lane={r.lane} changes={r.changes} api={api} navigate={navigate} />
                ))}
              </ul>
            )}
          </section>
        </main>
      </div>
      <aside style={{ position: 'relative', width: 360, flex: '0 0 360px', borderLeft: '1px solid var(--line)', background: 'var(--paper)', minHeight: 0 }}>
        <div style={{ position: 'absolute', inset: 0 }}>
          <Thread
            threadKey={`slide:${slideId}`}
            subtitle="about this slide; the co-author answers with a lane"
            hint={HINT}
            context={context}
            order={deck.order}
            slides={deck.slides}
            api={api}
            subscribe={fanout}
          />
        </div>
      </aside>
    </div>
  );
}
