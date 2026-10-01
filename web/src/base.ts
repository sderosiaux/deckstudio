/**
 * The studio serves many decks, each under /d/<id>/ (its API, socket, screens). The SPA learns which deck it shows
 * from the URL alone, read on every call: the home screen hands over to a deck with pushState, not a page load.
 * At the root (tests, a single-deck server) the base is empty and every path is the deck's own.
 */
const DECK_PREFIX = /^\/d\/([^/]+)(?=\/|$)/;

/** '/d/<id>' when the page is one deck's, '' otherwise. */
export function deckBase(pathname: string = location.pathname): string {
  return DECK_PREFIX.exec(pathname)?.[0] ?? '';
}

/** The deck the page shows, or null at the root. */
export function deckId(pathname: string = location.pathname): string | null {
  const seg = DECK_PREFIX.exec(pathname)?.[1];
  if (seg === undefined) return null;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** A deck-relative path ('/slide/x', '/?select=x', '/api/deck') under the current deck. */
export function withBase(path: string): string {
  return `${deckBase()}${path}`;
}

/** The screen part of a pathname: '/d/x/slide/s1' gives '/slide/s1', '/d/x' and '/d/x/' give '/'. */
export function routeOf(pathname: string): string {
  const rest = pathname.slice(deckBase(pathname).length);
  return rest === '' ? '/' : rest;
}
