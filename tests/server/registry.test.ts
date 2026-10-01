import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright';
import { STARTER_DESIGN_RULES } from '../../src/model/starter.js';
import { DEFAULT_THEME_CSS } from '../../src/render/defaultTheme.js';
import { BrowserPool } from '../../src/render/thumbs.js';
import { DeckRegistry, RegistryError, slugify } from '../../src/server/registry.js';
import { DeckStore } from '../../src/store/deckStore.js';
import { tmpDir } from '../helpers/tmp.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);
const rejectsWith = async (p: Promise<unknown>, status: number): Promise<void> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(RegistryError);
  expect((err as RegistryError).status).toBe(status);
};

describe('DeckRegistry', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let home: string;
  let registry: DeckRegistry;

  beforeEach(async () => {
    tmp = await tmpDir();
    home = join(tmp.dir, 'home');
    registry = await DeckRegistry.open(home, { checks: null });
  });
  afterEach(async () => {
    await registry.close();
    await tmp.cleanup();
  });

  it('opens on a missing home by creating it, and lists nothing', async () => {
    expect(await exists(home)).toBe(true);
    expect(await registry.list()).toEqual([]);
  });

  it('creates an empty deck with the generic starter brief, the default theme on disk and the title as id', async () => {
    const created = await registry.create({ title: 'Quarterly Review', audience: 'the board', message: 'we grew' });
    expect(created).toEqual({ id: 'quarterly-review', title: 'Quarterly Review', slides: 0, version: 0, updatedAt: expect.any(String), coverSlideId: null });
    expect(Number.isNaN(Date.parse(created.updatedAt))).toBe(false);

    const store = await DeckStore.open(join(home, 'quarterly-review'));
    const brief = await store.brief();
    expect(brief).toEqual({
      title: 'Quarterly Review',
      audience: 'the board',
      message: 'we grew',
      pattern: 'solution-first',
      abstract: '',
      design: { rules: STARTER_DESIGN_RULES, imageStyle: '' },
    });
    // Generic on purpose: nothing about a topic, a product or a conference.
    expect(brief.design.rules).not.toMatch(/kafka|summit|conduktor/i);
    expect((await store.state()).name).toBe('Quarterly Review');
    expect(await readFile(join(home, 'quarterly-review', 'theme.css'), 'utf8')).toBe(DEFAULT_THEME_CSS);
    expect(await registry.list()).toEqual([created]);
  });

  it('keeps the brief fields the creator gives and an explicit id', async () => {
    const created = await registry.create({
      id: 'q3',
      title: 'Q3',
      audience: 'a',
      message: 'm',
      pattern: 'problem-driven',
      abstract: 'abs',
      design: { rules: 'only black' },
    });
    expect(created.id).toBe('q3');
    expect(await (await DeckStore.open(join(home, 'q3'))).brief()).toMatchObject({ pattern: 'problem-driven', abstract: 'abs', design: { rules: 'only black', imageStyle: '' } });
  });

  it('answers 409 on an id already taken, and 400 on an invalid id', async () => {
    await registry.create({ title: 'Same', audience: '', message: '' });
    await rejectsWith(registry.create({ title: 'Same', audience: '', message: '' }), 409);
    await rejectsWith(registry.create({ id: 'same', title: 'Other', audience: '', message: '' }), 409);
    // Two concurrent creates of one id: exactly one wins, the loser leaves the winner's folder alone.
    const both = await Promise.allSettled([
      registry.create({ title: 'Race', audience: '', message: '' }),
      registry.create({ title: 'Race', audience: '', message: '' }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await registry.has('race')).toBe(true);
    await rejectsWith(registry.create({ id: '../escape', title: 'x', audience: '', message: '' }), 400);
  });

  it('slugs titles into URL-safe ids', () => {
    expect(slugify('Événement à Paris : 2026!')).toBe('evenement-a-paris-2026');
    expect(slugify('  ---  ')).toBe('deck');
    expect(slugify('x'.repeat(80))).toHaveLength(48);
  });

  it('imports a deck.html: title from <title>, slides and assets copied; a second import of it is a 409', async () => {
    const path = join(fixtures, 'deck-3.html');
    const imported = await registry.importHtml({ path });
    expect(imported).toMatchObject({ id: 'event-driven-memory-for-llm-agent-swarms', title: 'Event-Driven Memory for LLM Agent Swarms', slides: 3, version: 1 });
    expect(imported.coverSlideId).toMatch(/^s_/);
    expect(await readdir(join(home, imported.id, 'assets'))).toEqual(['s02.png']);
    expect((await (await DeckStore.open(join(home, imported.id))).brief()).design.rules).toBe(STARTER_DESIGN_RULES);
    await rejectsWith(registry.importHtml({ path }), 409);
    expect((await registry.importHtml({ id: 'copy', path })).id).toBe('copy');
  });

  it('refuses an import that is not a deck without leaving a folder behind', async () => {
    await rejectsWith(registry.importHtml({ path: join(tmp.dir, 'missing.html') }), 400);
    const page = join(tmp.dir, 'page.html');
    await writeFile(page, '<html><head><title>Not a deck</title></head><body><p>hi</p></body></html>');
    await rejectsWith(registry.importHtml({ path: page }), 400);
    expect(await readdir(home)).toEqual([]);
  });

  it('lists only deck folders, most recently changed first; backups and stray folders are skipped', async () => {
    await registry.create({ title: 'Old', audience: '', message: '' });
    const imported = await registry.importHtml({ path: join(fixtures, 'deck-3.html') });
    await cp(join(home, 'old'), join(home, 'old.bak-2026-09-30T10-00-00.000Z'), { recursive: true });
    await mkdir(join(home, 'not-a-deck'));
    const list = await registry.list();
    expect(list.map((d) => d.id).sort()).toEqual(['event-driven-memory-for-llm-agent-swarms', 'old']);
    expect([...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))).toEqual(list);
    expect(await registry.summary(imported.id)).toEqual(list.find((d) => d.id === imported.id));
    await rejectsWith(registry.summary('not-a-deck'), 404);
  });

  it('builds a deck\'s services once, on first use, and 404s an unknown deck', async () => {
    await registry.create({ title: 'A', audience: '', message: '' });
    const first = registry.services('a');
    expect(registry.services('a')).toBe(first);
    const a = await first;
    expect(a.store.dir).toBe(join(home, 'a'));
    expect(a.checks).toBeNull();
    await rejectsWith(registry.services('nope'), 404);
    // A deck copied into the home while the registry is open is served without reopening it.
    await cp(join(home, 'a'), join(home, 'late'), { recursive: true });
    expect((await registry.services('late')).store.dir).toBe(join(home, 'late'));
  });

  it('renders every deck\'s thumbs in one shared browser, each into its own cache dir with its own assets', async () => {
    const pool = new BrowserPool();
    const shared = await DeckRegistry.open(join(tmp.dir, 'shared'), { pool, checks: null });
    try {
      const one = await shared.importHtml({ id: 'one', path: join(fixtures, 'deck-3.html') });
      const two = await shared.importHtml({ id: 'two', path: join(fixtures, 'deck-3.html') });
      const [a, b] = await Promise.all([shared.services(one.id), shared.services(two.id)]);
      const browserOf = (s: typeof a): Browser => (s.thumbs as unknown as { browser: Browser }).browser;
      expect(browserOf(a)).toBe(browserOf(b));
      const slideA = (await a.store.snapshot()).slides[one.coverSlideId!]!;
      const slideB = (await b.store.snapshot()).slides[two.coverSlideId!]!;
      const [ta, tb] = await Promise.all([a.thumbs.thumb(slideA), b.thumbs.thumb(slideB)]);
      expect(ta.path.startsWith(join(tmp.dir, 'shared', 'one', 'cache'))).toBe(true);
      expect(tb.path.startsWith(join(tmp.dir, 'shared', 'two', 'cache'))).toBe(true);
      // Closing the registry stops each deck's context but leaves a pool it does not own running.
      await shared.close();
      expect(browserOf(a)).toBeNull();
      expect((await pool.acquire()).isConnected()).toBe(true);
    } finally {
      await shared.close();
      await pool.close();
    }
  });

  it('refuses services after close', async () => {
    await registry.create({ title: 'A', audience: '', message: '' });
    await registry.services('a');
    await registry.close();
    await expect(registry.services('a')).rejects.toThrow(/closed/);
  });
});
