import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import type { Slide } from '../model/types.js';
import { assembleSlideHtml, FONTS_DIR, STAGE_HEIGHT, STAGE_WIDTH } from './theme.js';

// Assets and fonts are served to the page through request interception on this origin, so
// the rendered HTML never needs file:// access. Every other request is aborted: renders are
// deterministic and work offline.
const ASSET_HOST = 'deckstudio.assets';
const ASSET_ORIGIN = `http://${ASSET_HOST}`;
const ASSET_BASE_URL = `${ASSET_ORIGIN}/assets`;
const FONTS_BASE_URL = `${ASSET_ORIGIN}/fonts`;
const RENDER_TIMEOUT_MS = 15_000;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export interface ThumbServiceOptions {
  cacheDir: string;
  themeCss: string;
  assetsDir: string;
  width?: 1280;
  height?: 720;
}

export interface ThumbResult {
  path: string;
  hash: string;
  cached: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export class ThumbService {
  private readonly thumbsDir: string;
  private readonly assetsDir: string;
  private readonly themeCss: string;
  private readonly width: number;
  private readonly height: number;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private starting: Promise<void> | null = null;
  /** True between start() and stop(): a crashed browser is relaunched only while running. */
  private running = false;
  private fonts: Promise<ReadonlyMap<string, Buffer>> | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: ThumbServiceOptions) {
    this.thumbsDir = join(opts.cacheDir, 'thumbs');
    this.assetsDir = resolve(opts.assetsDir);
    this.themeCss = opts.themeCss;
    this.width = opts.width ?? STAGE_WIDTH;
    this.height = opts.height ?? STAGE_HEIGHT;
  }

  async start(): Promise<void> {
    this.running = true;
    if (this.page && !this.page.isClosed()) return;
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.starting?.catch(() => undefined);
    const browser = this.browser;
    if (!browser) return;
    await this.tail.catch(() => undefined);
    this.browser = null;
    this.page = null;
    await browser.close();
  }

  private async launch(): Promise<void> {
    await mkdir(this.thumbsDir, { recursive: true });
    const fonts = await this.loadFonts();
    // A browser whose page was closed is still alive: drop it before launching a fresh one.
    const stale = this.browser;
    this.browser = null;
    this.page = null;
    await stale?.close().catch(() => undefined);
    const browser = await chromium.launch();
    try {
      browser.on('disconnected', () => {
        if (this.browser !== browser) return;
        this.browser = null;
        this.page = null;
      });
      // Scripts never run in a rendered slide: the body is sanitized, and JS is off as a second wall.
      const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: this.width, height: this.height } });
      await context.route('**/*', (route) => this.serve(route, fonts));
      const page = await context.newPage();
      await page.setViewportSize({ width: this.width, height: this.height });
      this.browser = browser;
      this.page = page;
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  /** Font files by name, read once; their bytes are part of every thumb hash. */
  private loadFonts(): Promise<ReadonlyMap<string, Buffer>> {
    this.fonts ??= (async () => {
      const names = (await readdir(FONTS_DIR)).sort();
      const entries = await Promise.all(names.map(async (n) => [n, await readFile(join(FONTS_DIR, n))] as const));
      return new Map(entries);
    })();
    this.fonts.catch(() => {
      this.fonts = null;
    });
    return this.fonts;
  }

  /** The public thumbnail id for a slide: render hash of its assembled HTML and asset bytes. */
  async thumbHash(slide: Slide): Promise<string> {
    return this.hashFor(this.slideHtml(slide), slide.assets);
  }

  /** Where a thumbnail with this hash lives once rendered (may not exist yet). */
  thumbPath(hash: string): string {
    return join(this.thumbsDir, `${hash}.png`);
  }

  async thumb(slide: Slide): Promise<ThumbResult> {
    const html = this.slideHtml(slide);
    const hash = await this.hashFor(html, slide.assets);
    const path = this.thumbPath(hash);
    if (await exists(path)) return { path, hash, cached: true };
    return this.enqueue(async () => {
      if (await exists(path)) return { path, hash, cached: true };
      const png = await this.screenshot(html);
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, png);
      await rename(tmp, path);
      return { path, hash, cached: false };
    });
  }

  /** Screenshots a full HTML document (e.g. from assembleSlideHtml) at the stage size. */
  async render(html: string): Promise<Buffer> {
    return this.enqueue(() => this.screenshot(html));
  }

  /** The base URL under which assets resolve inside rendered pages. */
  static get assetsBaseUrl(): string {
    return ASSET_BASE_URL;
  }

  /** The base URL under which the self-hosted fonts resolve inside rendered pages. */
  static get fontsBaseUrl(): string {
    return FONTS_BASE_URL;
  }

  private slideHtml(slide: Slide): string {
    return assembleSlideHtml(slide, { themeCss: this.themeCss, assetsBaseUrl: ASSET_BASE_URL, fontsBaseUrl: FONTS_BASE_URL });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async screenshot(html: string): Promise<Buffer> {
    if (!this.running) throw new Error('ThumbService not started: call start() first');
    // The browser may have crashed or been closed since start(): relaunch lazily.
    if (!this.page || this.page.isClosed()) await this.start();
    const page = this.page;
    if (!page) throw new Error('ThumbService: browser relaunch failed');
    await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
    return page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: this.width, height: this.height },
      timeout: RENDER_TIMEOUT_MS,
    });
  }

  // The thumb depends on the assembled HTML (title, body, kind, theme), on the font files and on
  // the bytes of the assets the slide declares, so replacing an asset or a font invalidates the cache.
  private async hashFor(html: string, assets: readonly string[]): Promise<string> {
    const h = createHash('sha256');
    h.update(`${this.width}x${this.height}\n`);
    h.update(html);
    for (const [name, bytes] of await this.loadFonts()) {
      h.update(`\nfont:${name}:${createHash('sha256').update(bytes).digest('hex')}`);
    }
    for (const name of [...assets].sort()) {
      const file = this.assetPath(name);
      h.update(`\nasset:${name}:`);
      if (!file) {
        h.update('invalid');
        continue;
      }
      try {
        h.update(createHash('sha256').update(await readFile(file)).digest('hex'));
      } catch {
        h.update('missing');
      }
    }
    return h.digest('hex');
  }

  /**
   * Slide.assets entries are 'assets/<name>' (importer convention) and request paths give the bare
   * name; both resolve to <assetsDir>/<name>. Anything nested or escaping is rejected.
   */
  private assetPath(name: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      return null;
    }
    const bare = decoded.replace(/^(?:\.\/)?assets\//, '');
    if (bare === '' || bare === '.' || bare === '..' || /[\/\\\0]/.test(bare)) return null;
    return join(this.assetsDir, bare);
  }

  private async serve(route: Route, fonts: ReadonlyMap<string, Buffer>): Promise<void> {
    let url: URL;
    try {
      url = new URL(route.request().url());
    } catch {
      return route.abort('blockedbyclient');
    }
    if (url.host !== ASSET_HOST) return route.abort('blockedbyclient');
    if (url.pathname.startsWith('/fonts/')) {
      const name = url.pathname.slice('/fonts/'.length);
      const body = fonts.get(name);
      if (!body || !name.endsWith('.woff2')) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, body, contentType: MIME['.woff2'] });
    }
    const prefix = '/assets/';
    const file = url.pathname.startsWith(prefix) ? this.assetPath(url.pathname.slice(prefix.length)) : null;
    if (!file) return route.fulfill({ status: 404, body: '' });
    try {
      const body = await readFile(file);
      await route.fulfill({
        status: 200,
        body,
        contentType: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  }
}
