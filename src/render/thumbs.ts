import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import type { Slide } from '../model/types.js';
import { assembleSlideHtml, STAGE_HEIGHT, STAGE_WIDTH } from './theme.js';

// Assets are served to the page through request interception on this origin, so
// the rendered HTML never needs file:// access.
const ASSET_ORIGIN = 'http://deckstudio.assets';
const ASSET_BASE_URL = `${ASSET_ORIGIN}/assets`;
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
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: ThumbServiceOptions) {
    this.thumbsDir = join(opts.cacheDir, 'thumbs');
    this.assetsDir = resolve(opts.assetsDir);
    this.themeCss = opts.themeCss;
    this.width = opts.width ?? STAGE_WIDTH;
    this.height = opts.height ?? STAGE_HEIGHT;
  }

  async start(): Promise<void> {
    if (this.browser) return;
    await mkdir(this.thumbsDir, { recursive: true });
    const browser = await chromium.launch();
    try {
      // Scripts never run in a rendered slide: the body is sanitized, and JS is off as a second wall.
      const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: this.width, height: this.height } });
      await context.route(`${ASSET_ORIGIN}/**`, (route) => this.serveAsset(route));
      const page = await context.newPage();
      await page.setViewportSize({ width: this.width, height: this.height });
      this.browser = browser;
      this.page = page;
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  async stop(): Promise<void> {
    const browser = this.browser;
    if (!browser) return;
    await this.tail.catch(() => undefined);
    this.browser = null;
    this.page = null;
    await browser.close();
  }

  /** The public thumbnail id for a slide: render hash of its assembled HTML and asset bytes. */
  async thumbHash(slide: Slide): Promise<string> {
    const html = assembleSlideHtml(slide, { themeCss: this.themeCss, assetsBaseUrl: ASSET_BASE_URL });
    return this.hashFor(html, slide.assets);
  }

  /** Where a thumbnail with this hash lives once rendered (may not exist yet). */
  thumbPath(hash: string): string {
    return join(this.thumbsDir, `${hash}.png`);
  }

  async thumb(slide: Slide): Promise<ThumbResult> {
    const html = assembleSlideHtml(slide, { themeCss: this.themeCss, assetsBaseUrl: ASSET_BASE_URL });
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

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async screenshot(html: string): Promise<Buffer> {
    const page = this.page;
    if (!page) throw new Error('ThumbService not started: call start() first');
    await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
    return page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: this.width, height: this.height },
      timeout: RENDER_TIMEOUT_MS,
    });
  }

  // The thumb depends on the assembled HTML (title, body, kind, theme) and on the bytes of
  // the assets the slide declares, so replacing an asset file invalidates the cache.
  private async hashFor(html: string, assets: readonly string[]): Promise<string> {
    const h = createHash('sha256');
    h.update(`${this.width}x${this.height}\n`);
    h.update(html);
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

  private assetPath(name: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      return null;
    }
    const file = resolve(this.assetsDir, decoded.replace(/^\/+/, ''));
    const rel = relative(this.assetsDir, file);
    if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) return null;
    return file;
  }

  private async serveAsset(route: Route): Promise<void> {
    const url = new URL(route.request().url());
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
