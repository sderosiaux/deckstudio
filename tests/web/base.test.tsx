// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deckBase, deckId, routeOf, withBase } from '../../web/src/base.js';
import * as api from '../../web/src/api.js';

const at = (path: string): void => history.replaceState(null, '', path);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  at('/');
  vi.unstubAllGlobals();
});

describe('deck base path', () => {
  it('is empty when the app is served single-deck at the root', () => {
    at('/history');
    expect(deckBase()).toBe('');
    expect(deckId()).toBeNull();
    expect(withBase('/slide/s1')).toBe('/slide/s1');
    expect(routeOf('/history')).toBe('/history');
  });

  it('is /d/<id> under a deck, whatever screen is open', () => {
    at('/d/my-talk/lane/l1/change/c1');
    expect(deckBase()).toBe('/d/my-talk');
    expect(deckId()).toBe('my-talk');
    expect(withBase('/')).toBe('/d/my-talk/');
    expect(withBase('/?select=s2')).toBe('/d/my-talk/?select=s2');
    expect(routeOf('/d/my-talk/slide/s2')).toBe('/slide/s2');
    at('/d/my-talk');
    expect(deckBase()).toBe('/d/my-talk');
    expect(routeOf('/d/my-talk')).toBe('/');
  });

  it('is empty on the home screen', () => {
    at('/');
    expect(deckBase()).toBe('');
  });
});

describe('api under /d/<id>', () => {
  it('prefixes every fetch with the deck base', async () => {
    at('/d/talk-1/history');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ laneId: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    await api.getVersions();
    await api.thumbFor('s 1');
    await api.openVersionAsLane(2);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/d/talk-1/api/versions', '/d/talk-1/api/thumbs/for/s%201', '/d/talk-1/api/history/open-as-lane']);
  });

  it('prefixes the client routes, the player and thumbnails', () => {
    at('/d/talk-1/');
    expect(api.slidePath('s2')).toBe('/d/talk-1/slide/s2');
    expect(api.focusPath('l1', 'c1')).toBe('/d/talk-1/lane/l1/change/c1');
    expect(api.mainPath({ kind: 'arc' })).toBe('/d/talk-1/');
    expect(api.mainPath({ kind: 'slide', slide: 's3' })).toBe('/d/talk-1/?select=s3');
    expect(api.mainHref()).toBe('/d/talk-1/');
    expect(api.briefPath()).toBe('/d/talk-1/brief');
    expect(api.historyPath()).toBe('/d/talk-1/history');
    expect(api.historyPath(1, 3)).toBe('/d/talk-1/history?a=1&b=3');
    expect(api.laneOnMainPath('l9')).toBe('/d/talk-1/#lane=l9');
    expect(api.playerHref(2)).toBe('/d/talk-1/api/present#3');
    expect(api.playerHref(-1)).toBe('/d/talk-1/api/present');
    expect(api.thumbUrl('abc')).toBe('/d/talk-1/api/thumbs/abc.png');
  });

  it('opens the socket on the deck path', () => {
    at('/d/talk-1/');
    const urls: string[] = [];
    class FakeWs {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((m: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        urls.push(url);
      }
      close(): void {}
    }
    vi.stubGlobal('WebSocket', FakeWs);
    const stop = api.subscribe(() => undefined);
    stop();
    expect(urls).toEqual([`ws://${location.host}/d/talk-1/ws`]);
  });

  it('keeps the deck list calls at the root, wherever the app is', async () => {
    at('/d/talk-1/');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json([]));
    vi.stubGlobal('fetch', fetchMock);
    await api.listDecks();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/decks');
    expect(api.deckHref('a b')).toBe('/d/a%20b/');
  });
});
