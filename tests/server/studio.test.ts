import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildStudio } from '../../src/server/app.js';
import type { DeckSummary } from '../../src/server/registry.js';
import { tmpDir } from '../helpers/tmp.js';
import { waitFor } from '../helpers/waitFor.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
// injectWS sends no Host header of its own; a browser always does.
const LOCAL = { headers: { host: '127.0.0.1:4177' } };

describe('studio: many decks in one server', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let app: FastifyInstance;

  const create = async (title: string, id?: string): Promise<DeckSummary> => {
    const res = await app.inject({ method: 'POST', url: '/api/decks', payload: { title, audience: 'ops', message: 'one idea', ...(id ? { id } : {}) } });
    expect(res.statusCode).toBe(201);
    return res.json();
  };
  const importFixture = async (id: string): Promise<DeckSummary> => {
    const res = await app.inject({ method: 'POST', url: '/api/decks/import', payload: { id, path: join(fixtures, 'deck-3.html') } });
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  beforeEach(async () => {
    tmp = await tmpDir();
    app = await buildStudio({ home: join(tmp.dir, 'decks'), checks: null });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await tmp.cleanup();
  });

  it('GET /api/decks lists the decks POST /api/decks and POST /api/decks/import made', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/decks' })).json()).toEqual([]);
    const made = await create('Team offsite');
    expect(made).toEqual({ id: 'team-offsite', title: 'Team offsite', slides: 0, version: 0, updatedAt: expect.any(String), coverSlideId: null });
    const imported = await importFixture('sf');
    expect(imported).toMatchObject({ id: 'sf', slides: 3, version: 1 });
    const list: DeckSummary[] = (await app.inject({ method: 'GET', url: '/api/decks' })).json();
    expect(list.map((d) => d.id).sort()).toEqual(['sf', 'team-offsite']);
    expect((await app.inject({ method: 'GET', url: '/api/decks/sf' })).json()).toEqual(imported);
    expect((await app.inject({ method: 'GET', url: '/api/decks/nope' })).statusCode).toBe(404);
  });

  it('POST /api/decks validates the body and answers 409 on a taken id', async () => {
    for (const payload of [{}, { title: '', audience: '', message: '' }, { title: 'x' }, { title: 'x', audience: '', message: '', id: '../up' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/decks', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    await create('Twice');
    expect((await app.inject({ method: 'POST', url: '/api/decks', payload: { title: 'Twice', audience: '', message: '' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/decks/import', payload: { path: join(fixtures, 'nope.html') } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/decks/import', payload: {} })).statusCode).toBe(400);
  });

  it('serves each deck under /d/<id>/, a deck created while running included, and 404s an unknown id', async () => {
    const imported = await importFixture('sf');
    const deck = (await app.inject({ method: 'GET', url: '/d/sf/api/deck' })).json();
    expect(deck.order).toHaveLength(3);
    expect(deck.state.version).toBe(1);
    await create('Fresh one');
    const fresh = (await app.inject({ method: 'GET', url: '/d/fresh-one/api/deck' })).json();
    expect(fresh).toMatchObject({ order: [], brief: { title: 'Fresh one', audience: 'ops', message: 'one idea' } });

    expect((await app.inject({ method: 'GET', url: '/d/nope/api/deck' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/d/..%2Fsf/api/deck' })).statusCode).toBe(404);
    await expect(app.injectWS('/d/nope/ws', LOCAL)).rejects.toThrow('404');

    // Assets come from that deck's folder only.
    const asset = await app.inject({ method: 'GET', url: '/d/sf/assets/s02.png' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toBe('image/png');
    expect((await app.inject({ method: 'GET', url: '/d/fresh-one/assets/s02.png' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/d/sf/assets/..%2Fdeck.json' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/d/sf/assets/../deck.json' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/fonts/Archivo-700.woff2' })).statusCode).toBe(200);

    // Present mode points at the deck's own assets and workbench.
    const present = (await app.inject({ method: 'GET', url: '/d/sf/api/present' })).body;
    expect(present).toContain('src="/d/sf/assets/s02.png"');
    expect(present).toContain('<script type="application/json" id="deck-base">"/d/sf"</script>');

    const thumb = await app.inject({ method: 'GET', url: `/d/sf/api/thumbs/for/${imported.coverSlideId}` });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.json()).toMatchObject({ hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const { hash } = await waitFor(async () => {
      const s = (await app.inject({ method: 'GET', url: `/d/sf/api/thumbs/for/${imported.coverSlideId}` })).json();
      return s.ready ? (s as { hash: string }) : null;
    });
    const png = await app.inject({ method: 'GET', url: `/d/sf/api/thumbs/${hash}.png` });
    expect(png.headers['content-type']).toBe('image/png');
    expect((await app.inject({ method: 'GET', url: `/d/fresh-one/api/thumbs/${hash}.png` })).statusCode).toBe(404);
  });

  it('keeps the local-request guard on the root routes and every deck', async () => {
    await create('Guarded');
    for (const url of ['/api/decks', '/d/guarded/api/deck', '/fonts/Archivo-700.woff2']) {
      expect((await app.inject({ method: 'GET', url, headers: { host: 'attacker.example' } })).statusCode, url).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/api/decks', headers: { host: '127.0.0.1:4177', origin: 'http://attacker.example' }, payload: { title: 'x', audience: '', message: '' } })).statusCode).toBe(403);
    await expect(app.injectWS('/d/guarded/ws', { headers: { host: 'attacker.example' } })).rejects.toThrow('403');
  });

  it('gives each deck its own bus: an event on deck A never reaches a /d/B/ws client', async () => {
    await create('Deck A', 'a');
    await create('Deck B', 'b');
    const got = { a: [] as unknown[], b: [] as unknown[] };
    const wsA = await app.injectWS('/d/a/ws', LOCAL, { onInit: (w) => w.on('message', (m: Buffer) => got.a.push(JSON.parse(m.toString()))) });
    const wsB = await app.injectWS('/d/b/ws', LOCAL, { onInit: (w) => w.on('message', (m: Buffer) => got.b.push(JSON.parse(m.toString()))) });
    try {
      await waitFor(() => got.a.length > 0 && got.b.length > 0);
      expect(got.a[0]).toEqual({ type: 'hello', version: 0 });
      const [a, b] = await Promise.all([app.registry.services('a'), app.registry.services('b')]);
      expect(a.bus).not.toBe(b.bus);
      a.bus.emit({ type: 'remarks.changed' });
      // B's marker is sent after A's event: once B has it, anything A leaked to B would already be there.
      b.bus.emit({ type: 'lane.closed', laneId: 'marker' });
      await waitFor(() => got.a.some((e) => (e as { type: string }).type === 'remarks.changed'));
      await waitFor(() => got.b.some((e) => (e as { type: string }).type === 'lane.closed'));
      expect(got.b).toEqual([{ type: 'hello', version: 0 }, { type: 'lane.closed', laneId: 'marker' }]);
      expect(got.a).toEqual([{ type: 'hello', version: 0 }, { type: 'remarks.changed' }]);

      // An edit through /d/b/ leaves deck A untouched.
      const brief = (await app.inject({ method: 'GET', url: '/d/b/api/brief' })).json();
      expect((await app.inject({ method: 'PUT', url: '/d/b/api/brief', payload: { ...brief, abstract: 'new' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/d/a/api/brief' })).json().abstract).toBe('');
    } finally {
      wsA.terminate();
      wsB.terminate();
    }
  });
});
