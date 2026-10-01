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
  type LanePreviewPayload,
  type SlideApi,
  type ThumbStatus,
} from '../api.js';
import { ChangeButtons } from '../components/ChangeButtons.js';
import { originTag, targetOf, useLaneActions } from '../components/LaneRow.js';
import { BackToMain, ScreenHeader } from '../components/ScreenHeader.js';
import { SlidePreview, type SlidePreviewProps } from '../components/SlidePreview.js';
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
.slide-toggle { display: flex; flex-wrap: wrap; gap: 4px; max-width: 800px; }
.slide-toggle > button { all: unset; cursor: pointer; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 10px; border-radius: 4px; font-size: var(--fs-meta); font-weight: 500; color: var(--grey); box-shadow: 0 0 0 1px var(--line); transition: color .15s ease, box-shadow .15s ease; }
.slide-toggle > button:hover { color: var(--ink); }
.slide-toggle > button[aria-pressed='true'] { color: var(--ink); background: var(--card); box-shadow: 0 0 0 1.5px var(--accent); }
`;
const TEXT_WIDTH = 800;

const HINT = 'Ask for a change to this slide. The co-author answers here with a lane: its render shows on the slide above, to accept or refuse in place.';

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
 * One slide of main, to change it by talking to the co-author: the slide large (main's render, or a lane's proposal),
 * the `slide:<id>` conversation right under it, then its story, notes and the open lanes that change it.
 */
export function Slide({ slideId, api = slideApi, subscribe = defaultSubscribe, navigate = defaultNavigate }: SlideProps) {
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
  }, [reloadDeck, reloadLanes, subscribe]);

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

  const shown = rows.find((r) => r.lane.id === view);
  const proposal = shown ? previews[shown.lane.id] : undefined;
  const mainUrl = thumb?.ready ? thumbUrl(thumb.hash) : undefined;
  let stage: SlidePreviewProps = { label: `main, slide ${at + 1}`, variant: 'main', title: slide.title, url: mainUrl };
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <ScreenHeader>
        <h1 data-testid="slide-crumb" className="screen-title" title={slide.title} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          slide {at + 1} of {deck.order.length}, {slide.title}
        </h1>
        {stepLink(prev, 'previous slide')}
        {stepLink(next, 'next slide')}
        <BackToMain navigate={navigate} />
      </ScreenHeader>
      {/* One column, one left edge on the title's (24px padding + the 120px gutter): the slide, the conversation about it, then its text and lanes. */}
      <main data-testid="slide-body" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 24px 48px calc(24px + var(--gutter))', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <style>{SLIDE_CSS}</style>
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
        <section aria-label="conversation about this slide" style={{ maxWidth: TEXT_WIDTH, padding: '4px 0 8px', borderBottom: '1px solid var(--line)' }}>
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
          />
        </section>
        <Field name="story" text={slide.story} testId="slide-story" empty="No story yet: ask the co-author to write the message this slide carries." />
        <Field name="notes" text={slide.notes} testId="slide-notes" empty="No speaker notes yet." />
        <section data-testid="slide-lanes" aria-label="lanes on this slide" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: TEXT_WIDTH, marginTop: 8 }}>
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
              No open lane changes this slide. Ask the co-author above; its lane shows on the slide and here.
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
  );
}
