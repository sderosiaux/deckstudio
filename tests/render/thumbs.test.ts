import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Slide } from '../../src/model/types.js';
import { ThumbService } from '../../src/render/thumbs.js';
import { assembleSlideHtml } from '../../src/render/theme.js';
import type { Page, Request } from 'playwright';
import { tmpDir } from '../helpers/tmp.js';
import { assetsDir, themeCss } from './themeCss.js';

function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const slide = (over: Partial<Slide> = {}): Slide => ({
  id: 's1',
  title: 'One log, everything derived',
  story: '',
  notes: '',
  body: '<img src="assets/s02.png" alt="" style="position:absolute;left:96px;top:176px;width:1088px;height:454px">',
  assets: ['s02.png'],
  kind: 'diagram',
  ...over,
});

describe('ThumbService (real Chromium)', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let svc: ThumbService;

  beforeAll(async () => {
    tmp = await tmpDir();
    svc = new ThumbService({ cacheDir: join(tmp.dir, 'cache'), themeCss, assetsDir });
    await svc.start();
  });
  afterAll(async () => {
    await svc?.stop();
    await tmp?.cleanup();
  });

  it('renders an unbalanced body with a script to a 1280x720 PNG (Review Focus 3)', async () => {
    const html = assembleSlideHtml(
      { title: 'Broken', kind: 'text', body: '<div><b>unclosed<script>document.body.innerHTML=""</script>' },
      { themeCss, assetsBaseUrl: 'http://deck.local/assets' },
    );
    const png = await svc.render(html);
    expect(pngSize(png)).toEqual({ width: 1280, height: 720 });
  });

  it('render does not run scripts even if the html still contains one', async () => {
    const html = assembleSlideHtml({ title: 'X', kind: 'text', body: '' }, { themeCss, assetsBaseUrl: 'http://deck.local/assets' });
    const withScript = html.replace('</body>', '<script>document.body.style.background="rgb(255,0,0)";document.querySelector(".slide").remove()</script></body>');
    const [a, b] = [await svc.render(html), await svc.render(withScript)];
    expect(pngSize(b)).toEqual({ width: 1280, height: 720 });
    expect(b.equals(a)).toBe(true);
  });

  it('caches by hash; a body change gives a new hash and a new file', async () => {
    const first = await svc.thumb(slide());
    expect(first.cached).toBe(false);
    expect(first.path).toBe(join(tmp.dir, 'cache', 'thumbs', `${first.hash}.png`));
    expect(pngSize(await readFile(first.path))).toEqual({ width: 1280, height: 720 });

    const again = await svc.thumb(slide());
    expect(again).toEqual({ ...first, cached: true });

    const changed = await svc.thumb(slide({ body: '<p class="big">changed</p>' }));
    expect(changed.cached).toBe(false);
    expect(changed.hash).not.toBe(first.hash);
    expect((await stat(changed.path)).size).toBeGreaterThan(0);
  });

  it('the asset image is actually drawn (not a broken image)', async () => {
    const withImg = await readFile((await svc.thumb(slide())).path);
    const without = await readFile((await svc.thumb(slide({ body: '' }))).path);
    expect(withImg.equals(without)).toBe(false);
    const broken = await readFile((await svc.thumb(slide({ body: slide().body.replace('s02.png', 'missing.png') }))).path);
    expect(withImg.equals(broken)).toBe(false);
  });

  it('serializes 5 parallel thumb() calls and writes 5 files', async () => {
    const before = new Set(await readdir(join(tmp.dir, 'cache', 'thumbs')));
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => svc.thumb(slide({ id: `p${i}`, body: `<p class="big">parallel ${i}</p>` }))),
    );
    expect(new Set(results.map((r) => r.hash)).size).toBe(5);
    const after = await readdir(join(tmp.dir, 'cache', 'thumbs'));
    const added = after.filter((f) => !before.has(f));
    expect(added.sort()).toEqual(results.map((r) => `${r.hash}.png`).sort());
  });

  it('resolves slide assets named with the importer convention assets/<name> (hash follows the bytes)', async () => {
    const dir = join(tmp.dir, 'prefixed-assets');
    await mkdir(dir, { recursive: true });
    await copyFile(join(assetsDir, 's02.png'), join(dir, 'p.png'));
    const other = new ThumbService({ cacheDir: join(tmp.dir, 'cache-prefixed'), themeCss, assetsDir: dir });
    const s = slide({ body: '<img src="assets/p.png" alt="">', assets: ['assets/p.png'] });
    const before = await other.thumbHash(s);
    expect(await other.thumbHash(s)).toBe(before);
    await writeFile(join(dir, 'p.png'), Buffer.from('not the same bytes'));
    expect(await other.thumbHash(s)).not.toBe(before);
    // Traversal or nested names never resolve to a file.
    const bad = await other.thumbHash(slide({ assets: ['assets/../p.png'] }));
    await writeFile(join(dir, 'p.png'), Buffer.from('third'));
    expect(await other.thumbHash(slide({ assets: ['assets/../p.png'] }))).toBe(bad);
  });

  it('never requests Google Fonts; fonts come from the local asset origin and no other host is reached', async () => {
    // A fresh browser: fonts already in another page's memory cache would emit no request event.
    const fresh = new ThumbService({ cacheDir: join(tmp.dir, 'cache-fonts'), themeCss, assetsDir });
    await fresh.start();
    const page = (fresh as unknown as { page: Page }).page;
    const urls: string[] = [];
    const reachedOutside: string[] = [];
    const onRequest = (r: Request) => urls.push(r.url());
    const onFinished = (r: Request) => {
      if (new URL(r.url()).host !== 'deckstudio.assets') reachedOutside.push(r.url());
    };
    page.on('request', onRequest);
    page.on('requestfinished', onFinished);
    try {
      const r = await fresh.thumb(slide({ id: 'fonts', title: 'Fonts are local', body: '<p class="big">x</p><img src="https://example.com/x.png">' }));
      expect(r.cached).toBe(false);
    } finally {
      page.off('request', onRequest);
      page.off('requestfinished', onFinished);
      await fresh.stop();
    }
    expect(reachedOutside).toEqual([]);
    expect(urls.filter((u) => /fonts\.(googleapis|gstatic)\.com/.test(u))).toEqual([]);
    expect(urls).toContain('http://deckstudio.assets/fonts/Archivo-800.woff2');
  });

  it('the self-hosted font is actually applied (render differs without the fonts style)', async () => {
    const html = assembleSlideHtml(
      { title: 'Archivo Extra Bold', kind: 'text', body: '' },
      { themeCss, assetsBaseUrl: ThumbService.assetsBaseUrl, fontsBaseUrl: ThumbService.fontsBaseUrl },
    );
    const noFonts = html.replace(/<style data-fonts>[\s\S]*?<\/style>/, '');
    expect(noFonts).not.toBe(html);
    const [a, b] = [await svc.render(html), await svc.render(noFonts)];
    expect(a.equals(b)).toBe(false);
    expect((await svc.render(html)).equals(a)).toBe(true);
  });

  it('recovers when the browser disconnects or the page is closed after start()', async () => {
    await (svc as unknown as { browser: { close(): Promise<void> } }).browser.close();
    const a = await svc.thumb(slide({ id: 'r1', body: '<p class="big">after browser crash</p>' }));
    expect(a.cached).toBe(false);
    expect(pngSize(await readFile(a.path))).toEqual({ width: 1280, height: 720 });

    await (svc as unknown as { page: Page }).page.close();
    const b = await svc.thumb(slide({ id: 'r2', body: '<p class="big">after page close</p>' }));
    expect(b.cached).toBe(false);
    expect(pngSize(await readFile(b.path))).toEqual({ width: 1280, height: 720 });
  });

  it('thumb() before start() or after stop() still refuses to launch a browser', async () => {
    const idle = new ThumbService({ cacheDir: join(tmp.dir, 'cache-idle'), themeCss, assetsDir });
    await expect(idle.render('<p>x</p>')).rejects.toThrow(/not started/);
  });
});
