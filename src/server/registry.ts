import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { parse } from 'node-html-parser';
import { z } from 'zod';
import { importDeckHtml } from '../import/fromDeckHtml.js';
import { starterBrief } from '../model/starter.js';
import { DEFAULT_THEME_CSS, loadThemeCss } from '../render/defaultTheme.js';
import { BrowserPool, ThumbService } from '../render/thumbs.js';
import { DeckStore } from '../store/deckStore.js';
import { createDeckServices, type DeckServices, type DeckServicesOptions } from './deckServices.js';

/** A deck as the home screen lists it. */
export interface DeckSummary {
  /** Folder name under the home; the deck's URL is /d/<id>/. */
  id: string;
  title: string;
  slides: number;
  version: number;
  /** deck.json mtime, ISO 8601: it is rewritten on every commit. */
  updatedAt: string;
  /** First slide of main, for the cover thumb (GET /d/<id>/api/thumbs/for/<coverSlideId>); null for an empty deck. */
  coverSlideId: string | null;
}

/** Deck ids are folder names and URL segments: letters, digits, '_' and '-', no dots (backups are skipped). */
export const DECK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const CreateDeckSchema = z.object({
  id: z.string().regex(DECK_ID, 'id: letters, digits, "_" and "-" only, at most 64').optional(),
  title: z.string().trim().min(1, 'title is required'),
  audience: z.string(),
  message: z.string(),
  pattern: z.enum(['solution-first', 'problem-driven']).optional(),
  abstract: z.string().optional(),
  design: z.object({ rules: z.string().optional(), imageStyle: z.string().optional() }).optional(),
});
export type CreateDeckInput = z.infer<typeof CreateDeckSchema>;

export const ImportDeckSchema = z.object({
  id: z.string().regex(DECK_ID, 'id: letters, digits, "_" and "-" only, at most 64').optional(),
  /** Absolute path of a single-file deck.html on this machine (relative paths resolve against the server's cwd). */
  path: z.string().trim().min(1, 'path is required'),
});
export type ImportDeckInput = z.infer<typeof ImportDeckSchema>;

export class RegistryError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** A URL-safe, lowercase folder name from a title: accents dropped, anything else becomes '-'. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'deck';
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

export interface DeckRegistryOptions {
  /** Shared Chromium for every deck's thumbnails; the registry creates (and closes) its own when absent. */
  pool?: BrowserPool;
  /** Passed to each deck's services: tests inject a fake agent factory and turn checks off with null. */
  agent?: DeckServicesOptions['agent'];
  checks?: null;
}

/**
 * The decks of one home folder. Services of a deck are built on first use and cached until close(), so a deck
 * created (or copied into the folder) while the server runs is served without a restart.
 */
export class DeckRegistry {
  private readonly services_ = new Map<string, Promise<DeckServices>>();
  private readonly pool: BrowserPool;
  private readonly ownsPool: boolean;
  private closed = false;

  private constructor(
    readonly home: string,
    private readonly opts: DeckRegistryOptions,
  ) {
    this.pool = opts.pool ?? new BrowserPool();
    this.ownsPool = opts.pool === undefined;
  }

  static async open(home: string, opts: DeckRegistryOptions = {}): Promise<DeckRegistry> {
    const abs = resolve(home);
    await mkdir(abs, { recursive: true });
    return new DeckRegistry(abs, opts);
  }

  private dir(id: string): string {
    return join(this.home, id);
  }

  /** True when id names a deck folder of this home. */
  async has(id: string): Promise<boolean> {
    return DECK_ID.test(id) && exists(join(this.dir(id), 'deck.json'));
  }

  /** Every deck of the home, most recently changed first. Folders that fail to load are left out. */
  async list(): Promise<DeckSummary[]> {
    const entries = await readdir(this.home, { withFileTypes: true });
    const ids = entries.filter((e) => e.isDirectory() && DECK_ID.test(e.name)).map((e) => e.name);
    const summaries = await Promise.all(ids.map((id) => this.summary(id).catch(() => null)));
    return summaries.filter((s): s is DeckSummary => s !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  /** One deck's summary; RegistryError 404 when the id is not a deck of this home. */
  async summary(id: string): Promise<DeckSummary> {
    if (!(await this.has(id))) throw new RegistryError(404, `unknown deck "${id}"`);
    const store = await DeckStore.open(this.dir(id));
    const [state, brief, info] = await Promise.all([store.state(), store.brief(), stat(join(store.dir, 'deck.json'))]);
    return {
      id,
      title: brief.title,
      slides: state.order.length,
      version: state.version,
      updatedAt: info.mtime.toISOString(),
      coverSlideId: state.order[0] ?? null,
    };
  }

  /** A new empty deck with the starter brief and the default theme. The id defaults to the title's slug. */
  async create(input: CreateDeckInput): Promise<DeckSummary> {
    const id = await this.claim(input.id ?? slugify(input.title));
    const dir = this.dir(id);
    const brief = starterBrief({
      title: input.title,
      audience: input.audience,
      message: input.message,
      ...(input.pattern ? { pattern: input.pattern } : {}),
      ...(input.abstract !== undefined ? { abstract: input.abstract } : {}),
    });
    const design = { rules: input.design?.rules ?? brief.design.rules, imageStyle: input.design?.imageStyle ?? brief.design.imageStyle };
    await this.inNewFolder(dir, async () => {
      await DeckStore.init(dir, input.title, { ...brief, design });
      // Written out (not left to the built-in fallback) so the creator can edit the look on disk.
      await writeFile(join(dir, 'theme.css'), DEFAULT_THEME_CSS);
    });
    return this.summary(id);
  }

  /**
   * A new deck from a single-file deck.html (one <section class="slide"> per slide). The title comes from the
   * page's <title>, else its first slide; the brief is the starter one, to be filled on the brief screen.
   */
  async importHtml(input: ImportDeckInput): Promise<DeckSummary> {
    const path = resolve(input.path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new RegistryError(400, `no file at ${path}`);
    const html = await readFile(path, 'utf8');
    const root = parse(html);
    const title =
      root.querySelector('title')?.text.trim() ||
      root.querySelector('section.slide h1, section.slide h2')?.text.replace(/\s+/g, ' ').trim() ||
      basename(path, extname(path));
    const id = await this.claim(input.id ?? slugify(title));
    const dir = this.dir(id);
    await this.inNewFolder(dir, async () => {
      try {
        await importDeckHtml({ html, htmlDir: resolve(path, '..'), outDir: dir, name: title, brief: starterBrief({ title, audience: '', message: '' }), store: DeckStore });
      } catch (err) {
        // The importer's own messages (no slide section, missing or clashing asset) are the creator's to fix.
        throw err instanceof Error && err.message.startsWith('import:') ? new RegistryError(400, err.message) : err;
      }
    });
    return this.summary(id);
  }

  /** The deck's services, built on first call; RegistryError 404 for an unknown id. */
  services(id: string): Promise<DeckServices> {
    if (this.closed) return Promise.reject(new Error('registry closed'));
    let pending = this.services_.get(id);
    if (!pending) {
      pending = this.build(id);
      this.services_.set(id, pending);
      // A failed open is not cached: the next request retries (e.g. a deck folder still being copied).
      pending.catch(() => {
        if (this.services_.get(id) === pending) this.services_.delete(id);
      });
    }
    return pending;
  }

  /** Disposes every deck's services, then the shared browser when the registry owns it. */
  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.services_.values()];
    this.services_.clear();
    await Promise.all(all.map(async (p) => (await p.catch(() => null))?.dispose()));
    if (this.ownsPool) await this.pool.close();
  }

  private async build(id: string): Promise<DeckServices> {
    if (!(await this.has(id))) throw new RegistryError(404, `unknown deck "${id}"`);
    const dir = this.dir(id);
    const store = await DeckStore.open(dir);
    // Per deck: cache dir, theme and assets. Shared: the browser.
    const thumbs = new ThumbService({ cacheDir: join(dir, 'cache'), themeCss: await loadThemeCss(dir), assetsDir: join(dir, 'assets'), pool: this.pool });
    await thumbs.start();
    try {
      return await createDeckServices({
        store,
        thumbs,
        ownsThumbs: true,
        ...(this.opts.agent ? { agent: this.opts.agent } : {}),
        ...(this.opts.checks === null ? { checks: null } : {}),
      });
    } catch (err) {
      await thumbs.stop();
      throw err;
    }
  }

  /** Reserves the id by creating its empty folder: mkdir is atomic, so two concurrent creates cannot both win. */
  private async claim(id: string): Promise<string> {
    if (!DECK_ID.test(id)) throw new RegistryError(400, `invalid deck id "${id}"`);
    try {
      await mkdir(this.dir(id));
    } catch (err) {
      if ((err as { code?: unknown }).code === 'EEXIST') throw new RegistryError(409, `a deck named "${id}" already exists`);
      throw err;
    }
    return id;
  }

  /** Runs fill in the folder claim() just made; on failure the half-made folder is removed. */
  private async inNewFolder(dir: string, fill: () => Promise<void>): Promise<void> {
    try {
      await fill();
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }
}
