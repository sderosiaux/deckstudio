import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DIAGRAM_STYLE } from '../../src/agent/imageGen.js';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import type { BusEvent } from '../../src/server/bus.js';
import { DeckStore } from '../../src/store/deckStore.js';
import { ThumbService } from '../../src/render/thumbs.js';
import type { Brief, Slide, Snapshot, Version } from '../../src/model/types.js';
import { chromium } from 'playwright';
import { tmpDir } from '../helpers/tmp.js';
import { waitFor } from '../helpers/waitFor.js';
import { assetsDir as fixtureAssets, themeCss } from '../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs', design: { rules: '', imageStyle: '' } };
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

// injectWS sends no Host header of its own; a browser always does.
const LOCAL = { headers: { host: '127.0.0.1:4177' } };

describe('server core', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let thumbs: ThumbService;
  let app: FastifyInstance;
  let events: BusEvent[];
  let deckDir: string;

  beforeAll(async () => {
    tmp = await tmpDir();
  });
  afterAll(async () => {
    await tmp?.cleanup();
  });

  beforeEach(async () => {
    deckDir = join(tmp.dir, `deck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const store = await DeckStore.init(deckDir, 'demo', brief);
    await store.commit(snap(five), { kind: 'import' });
    await writeFile(join(deckDir, 'theme.css'), themeCss);
    await copyFile(join(fixtureAssets, 's02.png'), join(deckDir, 'assets', 's02.png'));
    thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss, assetsDir: join(deckDir, 'assets') });
    await thumbs.start();
    app = await buildApp({ deckDir, thumbs, checks: null });
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

  it('refuses requests whose Host or Origin is not this machine, on HTTP and on the /ws upgrade', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/deck' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/deck', headers: { host: '127.0.0.1:4177', origin: 'http://localhost:5173' } })).statusCode).toBe(200);
    const denied = [
      { host: 'attacker.example' },
      { host: 'attacker.example:4177' },
      { host: '127.0.0.1.attacker.example' },
      { host: '127.0.0.1:4177', origin: 'http://attacker.example' },
      { host: '127.0.0.1:4177', origin: 'null' },
    ];
    for (const headers of denied) {
      expect((await app.inject({ method: 'GET', url: '/api/deck', headers })).statusCode, JSON.stringify(headers)).toBe(403);
      expect((await app.inject({ method: 'PATCH', url: '/api/slides/s3', headers, payload: { title: 'pwned' } })).statusCode).toBe(403);
      await expect(app.injectWS('/ws', { headers })).rejects.toThrow('403');
    }
    expect((await app.inject({ method: 'GET', url: '/api/deck' })).json().slides.s3.title).toBe('Title s3');
    await expect(app.injectWS('/ws')).rejects.toThrow('403');
  });

  it('greets every new socket with hello and the current deck version, so a reconnecting client can resync', async () => {
    const first = await waitForHello();
    expect(first).toEqual({ type: 'hello', version: 1 });
    await app.inject({ method: 'PATCH', url: '/api/slides/s3', payload: { title: 'New title' } });
    expect(await waitForHello()).toEqual({ type: 'hello', version: 2 });
  });

  const waitForHello = async (): Promise<unknown> => {
    const received: unknown[] = [];
    const ws = await app.injectWS('/ws', LOCAL, { onInit: (w) => w.on('message', (m: Buffer) => received.push(JSON.parse(m.toString()))) });
    try {
      return await waitFor(() => received[0]);
    } finally {
      ws.terminate();
    }
  };

  it('GET /api/slides/:id returns a slide or 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/slides/s3' })).json()).toEqual(five[2]);
    expect((await app.inject({ method: 'GET', url: '/api/slides/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/slides/..%2Fdeck' })).statusCode).toBe(404);
  });

  it('PATCH /api/slides/:id commits v2 with a manual accept cause and emits deck.changed over the bus and the socket', async () => {
    const ws = await app.injectWS('/ws', LOCAL);
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

  it('PATCH rejects a body that fails validateBody with its reasons, without committing', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/slides/s3', payload: { body: '<ul><li>x</li></ul><script>alert(1)</script>' } });
    expect(res.statusCode).toBe(400);
    const json = res.json();
    expect(json.error).toMatch(/body/i);
    expect(json.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/<ul>/), expect.stringMatching(/<script>/)]));
    expect((await app.inject({ method: 'PATCH', url: '/api/slides/s3', payload: { body: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/versions' })).json()).toHaveLength(2);
    expect(events).toEqual([]);
  });

  it('PATCH rejects asset names that escape the assets folder and accepts plain or assets/<name> ones', async () => {
    for (const bad of ['../deck.json', 'assets/../deck.json', 'assets/..', '..', '/etc/passwd', 'a\\b', 'assets/sub/x.png', 'x/y.png', 'assets/', '']) {
      const res = await app.inject({ method: 'PATCH', url: '/api/slides/s3', payload: { assets: [bad] } });
      expect(res.statusCode, bad).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url: '/api/versions' })).json()).toHaveLength(2);
    const ok = await app.inject({ method: 'PATCH', url: '/api/slides/s3', payload: { assets: ['assets/s02.png', 's02.png'] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().assets).toEqual(['assets/s02.png', 's02.png']);
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

  it('PUT /api/brief keeps the design rules and image style', async () => {
    const next: Brief = { ...brief, design: { rules: 'One accent colour.', imageStyle: 'Ink sketch.' } };
    expect((await app.inject({ method: 'PUT', url: '/api/brief', payload: next })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/brief' })).json()).toEqual(next);
  });

  it('GET /api/brief/design names the built-in image style and where the theme.css of the deck lives', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/brief/design' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ defaultImageStyle: DIAGRAM_STYLE, themeCssPath: join(resolve(deckDir), 'theme.css'), themeCssPresent: true });
    await rm(join(deckDir, 'theme.css'));
    expect((await app.inject({ method: 'GET', url: '/api/brief/design' })).json()).toMatchObject({ themeCssPresent: false });
  });

  it('GET /api/thumbs/for/:slideId enqueues a render, emits thumb.ready, then serves the PNG', async () => {
    const hash = await thumbs.thumbHash(five[1]!);
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

  it('GET /api/thumbs/version/:n/:slideId renders the slide as it was in version n, from the same hash cache', async () => {
    // v2 retitles s3: v1's s3 is no longer main's.
    expect((await app.inject({ method: 'PATCH', url: '/api/slides/s3', payload: { title: 'New title' } })).statusCode).toBe(200);
    const oldHash = await thumbs.thumbHash(five[2]!);
    const res = await app.inject({ method: 'GET', url: '/api/thumbs/version/1/s3' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hash: oldHash, ready: false });
    const mainHash = (await app.inject({ method: 'GET', url: '/api/thumbs/for/s3' })).json().hash;
    expect(mainHash).not.toBe(oldHash);

    // A past version's render is not main's slide: the event carries no slide id, clients match it by hash.
    await waitFor(() => events.some((e) => e.type === 'thumb.ready' && e.hash === oldHash), { timeout: 20_000 });
    expect(events.find((e) => e.type === 'thumb.ready' && e.hash === oldHash)).toEqual({ type: 'thumb.ready', hash: oldHash, slideId: null });
    expect((await app.inject({ method: 'GET', url: `/api/thumbs/${oldHash}.png` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/thumbs/version/1/s3' })).json()).toEqual({ hash: oldHash, ready: true });

    expect((await app.inject({ method: 'GET', url: '/api/thumbs/version/1/zz' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/thumbs/version/9/s3' })).statusCode).toBe(404);
    // v0 is the empty deck before the import.
    expect((await app.inject({ method: 'GET', url: '/api/thumbs/version/0/s3' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/thumbs/version/abc/s3' })).statusCode).toBe(400);
  });

  it('a failed thumbnail render emits thumb.failed for that slide', async () => {
    class FailingThumbs extends ThumbService {
      override thumb(): Promise<never> {
        return Promise.reject(new Error('boom'));
      }
    }
    const failing = new FailingThumbs({ cacheDir: join(deckDir, 'cache-failing'), themeCss, assetsDir: join(deckDir, 'assets') });
    const other = await buildApp({ deckDir, thumbs: failing, checks: null });
    const seen: BusEvent[] = [];
    other.bus.on('any', (e) => seen.push(e));
    try {
      const hash = await failing.thumbHash(five[2]!);
      const res = await other.inject({ method: 'GET', url: '/api/thumbs/for/s3' });
      expect(res.json()).toEqual({ hash, ready: false });
      await waitFor(() => seen.some((e) => e.type === 'thumb.failed'));
      expect(seen).toEqual([{ type: 'thumb.failed', hash, slideId: 's3', message: 'boom' }]);
    } finally {
      await other.close();
    }
  });

  it('GET /assets/* serves the deck assets folder', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/s02.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect((await app.inject({ method: 'GET', url: '/assets/missing.png' })).statusCode).toBe(404);
  });

  it('GET /fonts/* serves the self-hosted fonts used by the present page', async () => {
    const res = await app.inject({ method: 'GET', url: '/fonts/Archivo-700.woff2' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('font/woff2');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('wOF2');
    const present = (await app.inject({ method: 'GET', url: '/api/present' })).body;
    expect(present).toContain('url(/fonts/Archivo-700.woff2)');
    expect(present).not.toContain('googleapis');
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
    // Escape leaves the player for the workbench on the current slide.
    expect(html).toContain("e.key==='Escape'");
    expect(html).toContain("'/?select='");
    // e / Enter open the slide screen on the current slide.
    expect(html).toContain("'/slide/'");
  });

  it('GET /api/present sends a CSP whose script nonce matches the player script, and a fresh nonce per response', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/present' });
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com data:");
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).not.toContain("'unsafe-inline' 'nonce");
    const scripts = [...res.body.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]!);
    const executable = scripts.filter((attrs) => !attrs.includes('type="application/json"'));
    expect(executable).toEqual([` nonce="${nonce}"`]);
    for (const s of five) expect(res.body).toContain(`>${s.title}</h2>`);
    const again = await app.inject({ method: 'GET', url: '/api/present' });
    expect(String(again.headers['content-security-policy'])).not.toContain(nonce!);
  });

  it('present page isolates a slide body that tries to close the surrounding markup', async () => {
    await app.inject({ method: 'PATCH', url: '/api/slides/s2', payload: { body: '</section></div><p>escaped</p><div><b>open' } });
    const html = (await app.inject({ method: 'GET', url: '/api/present' })).body;
    expect(html.match(/<section class="slide"/g)).toHaveLength(5);
    expect(html.match(/<\/section>/g)).toHaveLength(5);
    const s2 = /<section class="slide" data-id="s2"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(s2).toContain('<p>escaped</p><div><b>open</b></div>');
    expect(html.indexOf('data-id="s3"')).toBeGreaterThan(html.indexOf('<p>escaped</p>'));
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
