import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { parse, type HTMLElement, type Node } from 'node-html-parser';
import type { Brief, DeckState, Slide, SlideKind, Snapshot, VersionCause } from '../model/types.js';

/** The slice of DeckStore the importer needs. The real store is wired at integration. */
export interface DeckWriter {
  init(dir: string, name: string, brief: Brief): Promise<{ commit(next: Snapshot, cause: VersionCause): Promise<unknown> }>;
}

export interface ImportResult { dir: string; slides: number; assetsCopied: number; themeCss: string }

export interface ImportOptions {
  html: string;
  /** Directory the deck.html lives in; relative `src` paths resolve against it. */
  htmlDir: string;
  outDir: string;
  name: string;
  brief: Brief;
  store?: DeckWriter;
}

const DEFAULT_MODEL = 'claude-opus-5';

const newSlideId = (): string => `s_${nanoid(10)}`;
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A src that points at a file next to the html (not a URL, data URI, fragment or root-absolute path). */
const isLocalPath = (src: string): boolean => src !== '' && !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(src);

interface ParsedSlide { slide: Slide; sources: Map<string, string> } // basename -> absolute source path

function headingTitle(h: HTMLElement | null): string {
  if (!h) return '';
  return collapse(parse(h.innerHTML.replace(/<br\s*\/?>/gi, ' ')).text);
}

/** Drop an element plus the whitespace-only text node right before it, so removed parts leave no blank lines. */
function removeWithIndent(el: HTMLElement): void {
  const parent = el.parentNode;
  if (!parent) return;
  const siblings = parent.childNodes;
  const i = siblings.indexOf(el);
  const prev: Node | undefined = i > 0 ? siblings[i - 1] : undefined;
  if (prev && prev.nodeType === 3 && prev.rawText.trim() === '') parent.removeChild(prev);
  parent.removeChild(el);
}

function kindOf(index: number, total: number, body: string): SlideKind {
  if (index === 0) return 'cover';
  if (index === total - 1) return 'close';
  if (/class="code"/.test(body)) return 'code';
  if (/<img[\s>]/i.test(body)) return 'diagram';
  return 'text';
}

function parseSection(section: HTMLElement, htmlDir: string, index: number, total: number): ParsedSlide {
  const heading = section.querySelector('h1, h2');
  const title = headingTitle(heading);
  const story = collapse(section.querySelector('.story')?.text ?? '');
  const notes = collapse(section.querySelector('aside.notes, .notes')?.text ?? '');

  // Only the title heading goes: a second h1/h2 would be body content, not chrome.
  if (heading) removeWithIndent(heading);
  for (const el of section.querySelectorAll('.story, .notes, .strata')) removeWithIndent(el);

  const sources = new Map<string, string>();
  for (const el of section.querySelectorAll('[src]')) {
    const raw = el.getAttribute('src') ?? '';
    if (!isLocalPath(raw)) continue;
    const clean = decodeURIComponent(raw.replace(/[?#].*$/, ''));
    const abs = resolve(htmlDir, clean);
    const name = basename(clean);
    sources.set(name, abs); // name clashes are checked deck-wide in importDeckHtml
    el.setAttribute('src', `assets/${name}`);
  }

  const body = section.innerHTML.trim();
  const slide: Slide = {
    id: newSlideId(),
    title,
    story,
    notes,
    body,
    assets: [...sources.keys()].map((n) => `assets/${n}`),
    kind: kindOf(index, total, body),
  };
  return { slide, sources };
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Import a single-file HTML deck (one `<section class="slide">` per slide) into a deck folder.
 * The importer owns theme.css and assets/; deck.json, brief.json and slides/ go through `store`
 * when given, otherwise they are written here in the store's layout at version 1.
 */
export async function importDeckHtml(opts: ImportOptions): Promise<ImportResult> {
  const { html, htmlDir, outDir, name, brief, store } = opts;
  if (await exists(join(outDir, 'deck.json'))) throw new Error(`import: ${outDir} already holds a deck (deck.json exists)`);

  const root = parse(html);
  const sections = root.querySelectorAll('section.slide');
  if (sections.length === 0) throw new Error('import: no <section class="slide"> found in the html');

  const parsed = sections.map((s, i) => parseSection(s, htmlDir, i, sections.length));
  const themeCss = root.querySelector('style')?.textContent ?? '';

  const allSources = new Map<string, string>();
  for (const { sources } of parsed) {
    for (const [n, abs] of sources) {
      const seen = allSources.get(n);
      if (seen !== undefined && seen !== abs) {
        throw new Error(`import: two assets share the name "${n}" (${seen} and ${abs}); rename one before importing`);
      }
      allSources.set(n, abs);
    }
  }
  for (const [n, abs] of allSources) {
    if (!(await exists(abs))) throw new Error(`import: asset "${n}" referenced by the deck is missing at ${abs}`);
  }

  const snapshot: Snapshot = {
    order: parsed.map((p) => p.slide.id),
    slides: Object.fromEntries(parsed.map((p) => [p.slide.id, p.slide])),
  };

  const writer = store ? await store.init(outDir, name, brief) : null;

  await mkdir(join(outDir, 'assets'), { recursive: true });
  for (const [n, abs] of allSources) await copyFile(abs, join(outDir, 'assets', n));
  await writeFile(join(outDir, 'theme.css'), themeCss);

  if (writer) {
    await writer.commit(snapshot, { kind: 'import' });
  } else {
    await mkdir(join(outDir, 'slides'), { recursive: true });
    for (const s of Object.values(snapshot.slides)) {
      await writeFile(join(outDir, 'slides', `${s.id}.json`), JSON.stringify(s, null, 2) + '\n');
    }
    await writeFile(join(outDir, 'brief.json'), JSON.stringify(brief, null, 2) + '\n');
    const deck: DeckState = { name, order: snapshot.order, version: 1, sessionId: null, model: DEFAULT_MODEL };
    await writeFile(join(outDir, 'deck.json'), JSON.stringify(deck, null, 2) + '\n');
  }

  return { dir: outDir, slides: parsed.length, assetsCopied: allSources.size, themeCss };
}

/** Convenience for scripts: read the html file and import it with its own directory as base. */
export async function importDeckHtmlFile(htmlPath: string, rest: Omit<ImportOptions, 'html' | 'htmlDir'>): Promise<ImportResult> {
  const abs = resolve(htmlPath);
  return importDeckHtml({ ...rest, html: await readFile(abs, 'utf8'), htmlDir: resolve(abs, '..') });
}
