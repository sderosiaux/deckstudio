import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, BRIEF_ROUTE, HISTORY_ROUTE, HOME_PATH, PRESENT_ROUTE, getDeckSummary, navigate } from './api.js';
import { deckId, routeOf } from './base.js';
import { ScreenHeader } from './components/ScreenHeader.js';
import { BriefChecks } from './screens/BriefChecks.js';
import { Focus } from './screens/Focus.js';
import { History } from './screens/History.js';
import { Home } from './screens/Home.js';
import { Main } from './screens/Main.js';
import { Present } from './screens/Present.js';
import { Slide } from './screens/Slide.js';

const currentPath = (): string => location.pathname.replace(/\/+$/, '') || '/';
const FOCUS = /^\/lane\/([^/]+)\/change\/([^/]+)$/;
const SLIDE = /^\/slide\/([^/]+)$/;

/** One deck's screens, picked by the route once the deck base is stripped ('/', '/history', '/slide/<id>'…). */
function DeckScreen({ route }: { route: string }) {
  if (route === PRESENT_ROUTE) return <Present />;
  if (route === BRIEF_ROUTE) return <BriefChecks />;
  if (route === HISTORY_ROUTE) return <History />;
  const focus = FOCUS.exec(route);
  if (focus) {
    const laneId = decodeURIComponent(focus[1]!);
    return <Focus key={laneId} laneId={laneId} changeId={decodeURIComponent(focus[2]!)} />;
  }
  const slide = SLIDE.exec(route);
  // No key: stepping to the next slide keeps the screen (and the deck it loaded) and swaps the slide.
  if (slide) return <Slide slideId={decodeURIComponent(slide[1]!)} />;
  return <Main />;
}

type Known = 'checking' | 'yes' | 'no';

/**
 * The server answers index.html for any /d/<id>/ page, known deck or not: ask once, so an unknown id reads as one
 * plain sentence instead of every screen's own load error. Any other failure lets the screen show its own.
 */
function DeckGate({ id, children }: { id: string; children: ReactNode }) {
  const [known, setKnown] = useState<Known>('checking');
  useEffect(() => {
    let live = true;
    getDeckSummary(id).then(
      () => live && setKnown('yes'),
      (err: unknown) => live && setKnown(err instanceof ApiError && err.status === 404 ? 'no' : 'yes'),
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (known === 'checking') return null;
  if (known === 'no') return <NoSuchDeck id={id} />;
  return <>{children}</>;
}

function NoSuchDeck({ id }: { id: string }) {
  return (
    <div>
      <ScreenHeader>
        <h1 className="screen-title">No such deck</h1>
      </ScreenHeader>
      <div style={{ padding: '24px 24px 0 calc(24px + var(--gutter))', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
        <p style={{ margin: 0 }}>No deck named “{id}” in this studio: it was renamed, removed, or the link is out of date.</p>
        <a
          href={HOME_PATH}
          className="link"
          style={{ color: 'var(--ink)' }}
          onClick={(e) => {
            e.preventDefault();
            navigate(HOME_PATH);
          }}
        >
          all decks
        </a>
      </div>
    </div>
  );
}

/**
 * No router library: the path picks the screen, and `navigate` (api.ts) re-renders through popstate. '/' is the home
 * screen; /d/<id>/… is one deck. Other root paths are a deck served alone at the root (single-deck server, tests).
 */
export function App() {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onPop = (): void => setPath(currentPath());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const id = deckId(path);
  if (id === null) return path === HOME_PATH ? <Home /> : <DeckScreen route={path} />;
  // Keyed by deck: another deck is a fresh mount, never one deck's state showing the next one's.
  return (
    <DeckGate key={id} id={id}>
      <DeckScreen route={routeOf(path)} />
    </DeckGate>
  );
}
