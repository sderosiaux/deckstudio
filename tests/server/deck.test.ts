import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import type { BusEvent } from '../../src/server/bus.js';
import { DeckStore } from '../../src/store/deckStore.js';
import { ThumbService } from '../../src/render/thumbs.js';
import { hashSlide } from '../../src/model/ids.js';
import type { Brief, Slide, Snapshot, Version } from '../../src/model/types.js';
import { chromium } from 'playwright';
import { tmpDir } from '../helpers/tmp.js';
import { waitFor } from '../helpers/waitFor.js';
import { assetsDir as fixtureAssets, themeCss } from '../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs' };
const slide = (id: string, over: Partial<Slide> = {}): Slide => ({
  id,
  title: `Title ${id}`,
  story: `story of ${id}`,
  notes: `notes of ${id}`,
  body: `<p class="cap">body ${id}</p>`,
  assets: [],
  kind: 'text',
  ...over,
});
const five: Slide[] = [
  slide('s1', { kind: 'cover' }),
  slide('s2', { kind: 'diagram', body: '<img src="assets/s02.png" alt="">', assets: ['s02.png'] }),
  slide('s3'),
  slide('s4'),
  slide('s5', { kind: 'close' }),
];
const snap = (slides: Slide[]): Snapshot => ({ order: slides.map((s) => s.id), slides: Object.fromEntries(slides.map((s) => [s.id, s])) });

describe('server core', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let thumbs: ThumbService;
  let app: FastifyInstance;
  let events: BusEvent[];

  beforeAll(async () => {
    tmp = await tmpDir();
  });
  afterAll(async () => {
    await tmp?.cleanup();
  });

  beforeEach(async () => {
    const deckDir = join(tmp.dir, `deck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const store = await DeckStore.init(deckDir, 'demo', brief);
    await store.commit(snap(five), { kind: 'import' });
    await writeFile(join(deckDir, 'theme.css'), themeCss);
    await copyFile(join(fixtureAssets, 's02.png'), join(deckDir, 'assets', 's02.png'));
    thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss, assetsDir: join(deckDir, 'assets') });
    await thumbs.start();
    app = await buildApp({ deckDir, thumbs });
    events = [];
    app.bus.on('any', (e) => events.push(e));
    await app.ready();
  });
  afterEach(async () => {
    await app?.close();
    await thumbs?.stop();
  });

  it('GET /api/deck returns the 5 fixture slides, state and brief', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/deck' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.order).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(Object.keys(body.slides)).toHaveLength(5);
    expect(body.slides.s2).toEqual(five[1]);
    expect(body.state).toMatchObject({ name: 'demo', version: 1, order: body.order });
    expect(body.brief).toEqual(brief);
  });

  it('GET /api/slides/:id returns a slide or 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/slides/s3' })).json()).toEqual(five[2]);
    expect((await app.inject({ method: 'GET', url: '/api/slides/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/slides/..%2Fdeck' })).statusCode).toBe(404);
  });

  it('PATCH /api/slides/:id commits v2 with a manual accept cause and emits deck.changed over the bus and the socket', async () => {
    const ws = await app.injectWS('/ws');
    const received: unknown[] = [];
    ws.on('message', (m: Buffer) => received.push(JSON.parse(m.toString())));
    try {
      const res = await app.inject({ method: 'PATCH', url: '/api/slides/s3', payload: { title: 'New title' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ...five[2], title: 'New title' });

      const versions: Version[] = (await app.inject({ method: 'GET', url: '/api/versions' })).json();
      expect(versions.map((v) => v.n)).toEqual([0, 1, 2]);
      expect(versions[2]!.cause).toEqual({ kind: 'accept', laneId: 'manual', changeId: 'manual' });
      expect(versions[2]!.order).toEqual(['s1', 's2', 's3', 's4', 's5']);

      const deck = (await app.inject({ method: 'GET', url: '/api/deck' })).json();
      expect(deck.state.version).toBe(2);
      expect(deck.slides.s3.title).toBe('New title');

      expect(events).toContainEqual({ type: 'deck.changed', version: 2 });
      await waitFor(() => received.some((e) => JSON.stringify(e) === JSON.stringify({ type: 'deck.changed', version: 2 })));
    } finally {
      ws.terminate();
    }
  });

  it('PATCH rejects an invalid patch and an unknown slide without committing', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/slides/s3', payload: { kind: 'poster' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/slides/s3', payload: { title: 42 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/slides/s3', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/slides/zz', payload: { title: 'x' } })).statusCode).toBe(404);
    const versions: Version[] = (await app.inject({ method: 'GET', url: '/api/versions' })).json();
    expect(versions).toHaveLength(2);
    expect(events).toEqual([]);
  });

  it('two concurrent PATCHes produce sequential versions, the second on top of the first', async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: 'PATCH', url: '/api/slides/s1', payload: { title: 'A' } }),
      app.inject({ method: 'PATCH', url: '/api/slides/s2', payload: { notes: 'B' } }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const deck = (await app.inject({ method: 'GET', url: '/api/deck' })).json();
    expect(deck.state.version).toBe(3);
    expect(deck.slides.s1.title).toBe('A');
    expect(deck.slides.s2.notes).toBe('B');
  });

  it('GET /api/versions/:n returns the snapshot of that version, 404 when missing, 400 when malformed', async () => {
    await app.inject({ method: 'PATCH', url: '/api/slides/s4', payload: { body: '<p>changed</p>' } });
    const v1 = (await app.inject({ method: 'GET', url: '/api/versions/1' })).json();
    expect(v1).toEqual(snap(five));
    const v2 = (await app.inject({ method: 'GET', url: '/api/versions/2' })).json();
    expect(v2.slides.s4.body).toBe('<p>changed</p>');
    expect((await app.inject({ method: 'GET', url: '/api/versions/9' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/versions/abc' })).statusCode).toBe(400);
  });

  it('GET/PUT /api/brief round-trips and validates', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/brief' })).json()).toEqual(brief);
    const next: Brief = { ...brief, message: 'derive everything' };
    const put = await app.inject({ method: 'PUT', url: '/api/brief', payload: next });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/brief' })).json()).toEqual(next);
    expect((await app.inject({ method: 'PUT', url: '/api/brief', payload: { ...next, pattern: 'random' } })).statusCode).toBe(400);
  });

  it('GET /api/thumbs/for/:slideId enqueues a render, emits thumb.ready, then serves the PNG', async () => {
    const hash = hashSlide(five[1]!);
    const first = await app.inject({ method: 'GET', url: '/api/thumbs/for/s2' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ hash, ready: false });
    expect((await app.inject({ method: 'GET', url: `/api/thumbs/${hash}.png` })).statusCode).toBe(404);

    await waitFor(() => events.some((e) => e.type === 'thumb.ready' && e.hash === hash && e.slideId === 's2'), { timeout: 20_000 });
    const png = await app.inject({ method: 'GET', url: `/api/thumbs/${hash}.png` });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect((await app.inject({ method: 'GET', url: '/api/thumbs/for/s2' })).json()).toEqual({ hash, ready: true });

    expect((await app.inject({ method: 'GET', url: '/api/thumbs/for/zz' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/thumbs/nothex.png' })).statusCode).toBe(404);
  });

  it('GET /assets/* serves the deck assets folder', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/s02.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect((await app.inject({ method: 'GET', url: '/assets/missing.png' })).statusCode).toBe(404);
  });

  it('GET /api/present returns one HTML page with every slide of main and the player', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/present' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const html = res.body;
    expect(html.match(/<section class="slide"/g)).toHaveLength(5);
    expect(html).toContain('.slide{');
    for (const s of five) expect(html).toContain(`>${s.title}</h2>`);
    expect(html).toContain('src="/assets/s02.png"');
    expect(html).toContain('story of s3');
    expect(html).toContain('ArrowRight');
    expect(html).toContain('location.hash');
  });

  it('present page plays like the original deck: #n, arrows, "s" story panel, "n" notes to console', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const logs: string[] = [];
      page.on('console', (m) => logs.push(m.text()));
      await page.goto(`${address}/api/present#3`);
      const active = () => page.evaluate(() => document.querySelector('#viewport>.slide.active')?.getAttribute('data-id'));
      expect(await active()).toBe('s3');
      await page.keyboard.press('ArrowRight');
      expect(await active()).toBe('s4');
      expect(await page.evaluate(() => location.hash)).toBe('#4');
      await page.keyboard.press('s');
      expect(await page.evaluate(() => document.body.classList.contains('story'))).toBe(true);
      expect(await page.textContent('#story')).toContain('story of s4');
      await page.keyboard.press('n');
      await waitFor(() => logs.includes('notes of s4'));
      await page.evaluate(() => { location.hash = '#1'; });
      await waitFor(async () => (await active()) === 's1');
      expect(await page.evaluate(() => document.querySelectorAll('#viewport>.slide.active').length)).toBe(1);
    } finally {
      await browser.close();
    }
  });
});
