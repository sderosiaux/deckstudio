import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDeckHtml, type DeckWriter } from '../../src/import/fromDeckHtml.js';
import { DeckStateSchema, SlideSchema, BriefSchema } from '../../src/model/schema.js';
import type { Brief, Snapshot, VersionCause } from '../../src/model/types.js';
import { tmpDir } from '../helpers/tmp.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const brief: Brief = { title: 'T', audience: 'A', message: 'M', pattern: 'solution-first', abstract: 'Abs' };

describe('importDeckHtml', () => {
  let out: { dir: string; cleanup: () => Promise<void> };
  beforeEach(async () => { out = await tmpDir(); });
  afterEach(async () => { await out.cleanup(); });

  it('imports three sections into a deck folder', async () => {
    const html = await readFile(join(fixtures, 'deck-3.html'), 'utf8');
    const outDir = join(out.dir, 'deck');
    const res = await importDeckHtml({ html, htmlDir: fixtures, outDir, name: 'mini', brief });

    expect(res).toMatchObject({ dir: outDir, slides: 3, assetsCopied: 1 });
    expect(res.themeCss).toContain('.slide{');
    expect(await readFile(join(outDir, 'theme.css'), 'utf8')).toBe(res.themeCss);

    const deck = DeckStateSchema.parse(JSON.parse(await readFile(join(outDir, 'deck.json'), 'utf8')));
    expect(deck).toMatchObject({ name: 'mini', version: 1, sessionId: null, model: 'claude-opus-5' });
    expect(deck.order).toHaveLength(3);
    for (const id of deck.order) expect(id).toMatch(/^s_[A-Za-z0-9_-]{10}$/);
    expect(BriefSchema.parse(JSON.parse(await readFile(join(outDir, 'brief.json'), 'utf8')))).toEqual(brief);

    const slides = await Promise.all(
      deck.order.map(async (id) => SlideSchema.parse(JSON.parse(await readFile(join(outDir, 'slides', `${id}.json`), 'utf8')))),
    );
    expect(slides.map((s) => s.title)).toEqual(['One log, everything derived', 'Lease, ack, release', 'Typed in, typed out']);
    expect(slides.map((s) => s.kind)).toEqual(['cover', 'code', 'close']);
    expect(slides.map((s) => s.id)).toEqual(deck.order);

    const [img, code, jev] = slides as [typeof slides[0], typeof slides[0], typeof slides[0]];
    expect(img.story).toMatch(/^The whole picture first/);
    expect(img.notes).toMatch(/^Four bands\./);
    expect(img.body).toContain('src="assets/s02.png"');
    expect(img.body).not.toMatch(/<h[12]|class="story"|class="notes"|class="strata/);
    expect(img.assets).toEqual(['assets/s02.png']);
    const copied = await readFile(join(outDir, 'assets', 's02.png'));
    expect(copied.equals(await readFile(join(fixtures, 'assets', 's02.png')))).toBe(true);

    expect(code.body).toContain('<div class="code">');
    expect(code.body).toContain('&quot;auto.offset.reset&quot;');
    expect(code.notes).toMatch(/Kafka 4\.3\.0/);
    expect(code.assets).toEqual([]);

    expect(jev.body).toContain('<span class="grey" style="font-weight:700">POST /v1/systemone</span>');
    expect(jev.body).toContain('<svg viewBox="0 0 1280 720"');
    expect(jev.body).not.toContain('<h2');
  });

  it('classifies middle slides as diagram / code / text', async () => {
    const html = `<html><head><style>.slide{x:1}</style></head><body>
<section class="slide"><h1>Cover</h1></section>
<section class="slide"><h2>Pic</h2><img src="https://example.com/a.png"></section>
<section class="slide"><h2>Code</h2><div class="code">x</div></section>
<section class="slide"><h2>Words &amp; more</h2><p>hi</p></section>
<section class="slide"><h2>End</h2></section>
</body></html>`;
    const res = await importDeckHtml({ html, htmlDir: out.dir, outDir: join(out.dir, 'd'), name: 'k', brief });
    expect(res.assetsCopied).toBe(0);
    const deck = JSON.parse(await readFile(join(out.dir, 'd', 'deck.json'), 'utf8')) as { order: string[] };
    const slides = await Promise.all(deck.order.map(async (id) => JSON.parse(await readFile(join(out.dir, 'd', 'slides', `${id}.json`), 'utf8')) as { kind: string; title: string; body: string }));
    expect(slides.map((s) => s.kind)).toEqual(['cover', 'diagram', 'code', 'text', 'close']);
    expect(slides[3]?.title).toBe('Words & more');
    expect(slides[1]?.body).toContain('src="https://example.com/a.png"');
  });

  it('a section without .story yields story "" and h1 with <br> gives a spaced title', async () => {
    const html = `<html><head><style>.slide{}</style></head><body>
<section class="slide"><h1>Event-Driven Memory<br>for LLM <span class="acc">Agent Swarms</span></h1><aside class="notes">n</aside></section>
</body></html>`;
    await importDeckHtml({ html, htmlDir: out.dir, outDir: join(out.dir, 'd'), name: 'k', brief });
    const deck = JSON.parse(await readFile(join(out.dir, 'd', 'deck.json'), 'utf8')) as { order: string[] };
    const s = SlideSchema.parse(JSON.parse(await readFile(join(out.dir, 'd', 'slides', `${deck.order[0]}.json`), 'utf8')));
    expect(s).toMatchObject({ story: '', notes: 'n', title: 'Event-Driven Memory for LLM Agent Swarms', kind: 'cover' });
    expect((await stat(join(out.dir, 'd', 'assets'))).isDirectory()).toBe(true);
  });

  it('fails loudly when a referenced asset is missing', async () => {
    const html = `<html><head><style>.slide{}</style></head><body><section class="slide"><h2>x</h2><img src="nope/missing.png"></section></body></html>`;
    await expect(importDeckHtml({ html, htmlDir: out.dir, outDir: join(out.dir, 'd'), name: 'k', brief })).rejects.toThrow(/missing\.png/);
  });

  it('rejects two different sources sharing a basename', async () => {
    await writeFile(join(out.dir, 'a.png'), 'a');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(out.dir, 'sub'));
    await writeFile(join(out.dir, 'sub', 'a.png'), 'b');
    const html = `<html><head><style>.slide{}</style></head><body><section class="slide"><h2>x</h2><img src="a.png"></section><section class="slide"><h2>y</h2><img src="sub/a.png"></section></body></html>`;
    await expect(importDeckHtml({ html, htmlDir: out.dir, outDir: join(out.dir, 'd'), name: 'k', brief })).rejects.toThrow(/a\.png/);
  });

  it('refuses to import over an existing deck', async () => {
    const html = await readFile(join(fixtures, 'deck-3.html'), 'utf8');
    const outDir = join(out.dir, 'deck');
    await importDeckHtml({ html, htmlDir: fixtures, outDir, name: 'mini', brief });
    await expect(importDeckHtml({ html, htmlDir: fixtures, outDir, name: 'mini', brief })).rejects.toThrow(/already holds a deck/);
  });

  it('throws when there is no <section class="slide">', async () => {
    await expect(importDeckHtml({ html: '<html><body></body></html>', htmlDir: out.dir, outDir: join(out.dir, 'd'), name: 'k', brief })).rejects.toThrow(/section/);
  });

  it('delegates persistence to a store when given', async () => {
    const calls: { dir: string; name: string; brief: Brief; commits: { next: Snapshot; cause: VersionCause }[] } = { dir: '', name: '', brief, commits: [] };
    const store: DeckWriter = {
      async init(dir, name, b) {
        calls.dir = dir; calls.name = name; calls.brief = b;
        return { async commit(next, cause) { calls.commits.push({ next, cause }); return null; } };
      },
    };
    const html = await readFile(join(fixtures, 'deck-3.html'), 'utf8');
    const outDir = join(out.dir, 'deck');
    const res = await importDeckHtml({ html, htmlDir: fixtures, outDir, name: 'mini', brief, store });
    expect(res.slides).toBe(3);
    expect(calls).toMatchObject({ dir: outDir, name: 'mini' });
    expect(calls.commits).toHaveLength(1);
    expect(calls.commits[0]?.cause).toEqual({ kind: 'import' });
    expect(calls.commits[0]?.next.order).toHaveLength(3);
    // assets and theme are still written by the importer; deck.json is the store's job
    expect(await readdir(join(outDir, 'assets'))).toEqual(['s02.png']);
    expect(await readFile(join(outDir, 'theme.css'), 'utf8')).toContain('.slide{');
    await expect(stat(join(outDir, 'deck.json'))).rejects.toThrow();
  });
});
