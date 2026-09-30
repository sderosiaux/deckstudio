import { randomBytes } from 'node:crypto';
import { access, appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { z } from 'zod';
import { hashSlide } from '../model/ids.js';
import {
  BriefSchema,
  DeckStateSchema,
  LaneSchema,
  RemarkSchema,
  SlideSchema,
  ThreadMessageSchema,
  VersionSchema,
} from '../model/schema.js';
import type { Brief, DeckState, Lane, Remark, Slide, SlideId, Snapshot, ThreadKey, ThreadMessage, Version, VersionCause } from '../model/types.js';
import { mutexFor, type Mutex } from './locks.js';

export const DEFAULT_MODEL = 'claude-opus-5';

const LAYOUT_DIRS = ['slides', 'assets', 'objects', 'versions', 'lanes', 'threads', join('cache', 'thumbs')];
// Ids end up in file names: restrict them so nothing can escape the deck folder.
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

function assertSafe(kind: string, name: string): void {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid ${kind} id "${name}": only letters, digits, '_' and '-' are allowed`);
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT';
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function readJson<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  const raw = await readFile(path, 'utf8');
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`corrupt file ${path}: ${parsed.error.message}`);
  return parsed.data;
}

async function readJsonOrNull<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S> | null> {
  try {
    return await readJson(path, schema);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

// OriginSchema / ThreadKeySchema validate `check:*`, `lane:*`, `remark:*` by regex, so zod infers plain
// `string` where the domain types use template literals. After parsing, the values satisfy the narrower types.
const asLane = (l: z.infer<typeof LaneSchema>): Lane => l as Lane;
const asRemark = (r: z.infer<typeof RemarkSchema>): Remark => r as Remark;
const asMessage = (m: z.infer<typeof ThreadMessageSchema>): ThreadMessage => m as ThreadMessage;

function threadFile(key: ThreadKey): string {
  const name = key.replace(/:/g, '_');
  assertSafe('thread', name);
  return `${name}.jsonl`;
}

export class DeckStore {
  readonly dir: string;
  private readonly deckLock: Mutex;
  // Guards read-modify-write of deck.json only; distinct from the deck lock so
  // setSessionId can be called from inside withLock without deadlocking.
  private readonly stateLock: Mutex;

  private constructor(dir: string) {
    this.dir = dir;
    this.deckLock = mutexFor(`deck:${dir}`);
    this.stateLock = mutexFor(`state:${dir}`);
  }

  static async open(dir: string): Promise<DeckStore> {
    const abs = resolve(dir);
    if (!(await exists(join(abs, 'deck.json')))) throw new Error(`not a deck folder (no deck.json): ${abs}`);
    const store = new DeckStore(abs);
    await store.state();
    return store;
  }

  static async init(dir: string, name: string, brief: Brief): Promise<DeckStore> {
    const abs = resolve(dir);
    if (await exists(join(abs, 'deck.json'))) throw new Error(`deck already exists: ${abs}`);
    for (const d of LAYOUT_DIRS) await mkdir(join(abs, d), { recursive: true });
    const store = new DeckStore(abs);
    await writeJsonAtomic(store.path('brief.json'), BriefSchema.parse(brief));
    await writeJsonAtomic(store.path('remarks.json'), []);
    const v0: Version = { n: 0, order: [], slides: {}, cause: { kind: 'import' }, createdAt: new Date().toISOString() };
    await writeJsonAtomic(store.path('versions', 'v0.json'), v0);
    const state: DeckState = { name, order: [], version: 0, sessionId: null, model: DEFAULT_MODEL };
    // deck.json last: its presence is what marks the folder as a deck.
    await writeJsonAtomic(store.path('deck.json'), state);
    return store;
  }

  private path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  async state(): Promise<DeckState> {
    return readJson(this.path('deck.json'), DeckStateSchema);
  }

  private updateState(fn: (s: DeckState) => DeckState): Promise<DeckState> {
    return this.stateLock.run(async () => {
      const next = fn(await this.state());
      await writeJsonAtomic(this.path('deck.json'), next);
      return next;
    });
  }

  async brief(): Promise<Brief> {
    return readJson(this.path('brief.json'), BriefSchema);
  }

  async setBrief(b: Brief): Promise<void> {
    await writeJsonAtomic(this.path('brief.json'), BriefSchema.parse(b));
  }

  async slide(id: SlideId): Promise<Slide | null> {
    if (!SAFE_NAME.test(id)) return null;
    return readJsonOrNull(this.path('slides', `${id}.json`), SlideSchema);
  }

  async snapshot(): Promise<Snapshot> {
    const { order } = await this.state();
    const slides: Record<SlideId, Slide> = {};
    for (const id of order) {
      const s = await this.slide(id);
      if (!s) throw new Error(`deck.json lists slide "${id}" but slides/${id}.json is missing`);
      slides[id] = s;
    }
    return { order, slides };
  }

  async snapshotAt(n: number): Promise<Snapshot> {
    if (!Number.isInteger(n) || n < 0) throw new Error(`invalid version ${n}`);
    const v = await readJsonOrNull(this.path('versions', `v${n}.json`), VersionSchema);
    if (!v) throw new Error(`version ${n} does not exist`);
    const slides: Record<SlideId, Slide> = {};
    for (const id of v.order) {
      const hash = v.slides[id];
      if (!hash) throw new Error(`version ${n} lists slide "${id}" without an object hash`);
      const obj = await readJsonOrNull(this.path('objects', `${hash}.json`), SlideSchema);
      if (!obj) throw new Error(`version ${n}: object ${hash} for slide "${id}" is missing`);
      // Objects are shared by content: the stored id is whichever slide wrote it first, so the key wins.
      slides[id] = { ...obj, id };
    }
    return { order: v.order, slides };
  }

  /**
   * Makes `next` the new main. Not locked by itself: callers that read-then-commit
   * must wrap the whole sequence in withLock to keep versions sequential.
   */
  async commit(next: Snapshot, cause: VersionCause): Promise<Version> {
    const seen = new Set<SlideId>();
    for (const id of next.order) {
      assertSafe('slide', id);
      if (seen.has(id)) throw new Error(`slide "${id}" appears twice in order`);
      seen.add(id);
      const s = next.slides[id];
      if (!s) throw new Error(`order lists slide "${id}" but the snapshot has no such slide`);
      if (s.id !== id) throw new Error(`slide keyed "${id}" carries id "${s.id}"`);
      SlideSchema.parse(s);
    }
    const { version } = await this.state();
    const n = version + 1;

    // Write order makes deck.json the single commit point: objects, then the version file, then deck.json,
    // then the slides/ working copy. A crash before deck.json leaves at most an orphan v{n}.json above the
    // committed version, which the next commit overwrites.
    const hashes: Record<SlideId, string> = {};
    for (const id of next.order) {
      const s = next.slides[id]!;
      const hash = hashSlide(s);
      hashes[id] = hash;
      const objPath = this.path('objects', `${hash}.json`);
      // Objects are content-addressed; the id is not part of the hash, so the stored id is whichever wrote it first.
      if (!(await exists(objPath))) await writeJsonAtomic(objPath, s);
    }
    const v: Version = { n, order: [...next.order], slides: hashes, cause, createdAt: new Date().toISOString() };
    await writeJsonAtomic(this.path('versions', `v${n}.json`), v);
    await this.updateState((s) => ({ ...s, order: [...next.order], version: n }));

    for (const id of next.order) await writeJsonAtomic(this.path('slides', `${id}.json`), next.slides[id]!);
    for (const f of await readdir(this.path('slides'))) {
      if (f.endsWith('.json') && !seen.has(f.slice(0, -5))) await rm(this.path('slides', f), { force: true });
    }
    return v;
  }

  /** Committed versions only: a v{n}.json above deck.json's version is a crash leftover, not history. */
  async versions(): Promise<Version[]> {
    const { version } = await this.state();
    const files = (await readdir(this.path('versions'))).filter((f) => /^v\d+\.json$/.test(f) && Number(f.slice(1, -5)) <= version);
    const vs = await Promise.all(files.map((f) => readJson(this.path('versions', f), VersionSchema)));
    return vs.sort((a, b) => a.n - b.n);
  }

  async lanes(): Promise<Lane[]> {
    const files = (await readdir(this.path('lanes'))).filter((f) => f.endsWith('.json'));
    const ls = await Promise.all(files.map((f) => readJson(this.path('lanes', f), LaneSchema)));
    return ls.map(asLane).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async lane(id: string): Promise<Lane | null> {
    if (!SAFE_NAME.test(id)) return null;
    const l = await readJsonOrNull(this.path('lanes', `${id}.json`), LaneSchema);
    return l ? asLane(l) : null;
  }

  async putLane(l: Lane): Promise<void> {
    assertSafe('lane', l.id);
    await writeJsonAtomic(this.path('lanes', `${l.id}.json`), LaneSchema.parse(l));
  }

  async remarks(): Promise<Remark[]> {
    return ((await readJsonOrNull(this.path('remarks.json'), RemarkSchema.array())) ?? []).map(asRemark);
  }

  async putRemarks(r: Remark[]): Promise<void> {
    await writeJsonAtomic(this.path('remarks.json'), RemarkSchema.array().parse(r));
  }

  async thread(key: ThreadKey): Promise<ThreadMessage[]> {
    let raw: string;
    try {
      raw = await readFile(this.path('threads', threadFile(key)), 'utf8');
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => asMessage(ThreadMessageSchema.parse(JSON.parse(line))));
  }

  async appendMessage(m: ThreadMessage): Promise<void> {
    const line = JSON.stringify(ThreadMessageSchema.parse(m)) + '\n';
    await appendFile(this.path('threads', threadFile(m.thread)), line, 'utf8');
  }

  async setSessionId(id: string | null): Promise<void> {
    await this.updateState((s) => ({ ...s, sessionId: id }));
  }

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.deckLock.run(fn);
  }
}
