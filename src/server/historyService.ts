import { z } from 'zod';
import { newId } from '../model/ids.js';
import { diffVersions } from '../model/ops.js';
import type { Change, DiffEntry, Lane, Slide, SlideId, SlidePatch, Snapshot, Version } from '../model/types.js';
import { SlidePatchSchema } from '../model/schema.js';
import type { DeckStore } from '../store/deckStore.js';
import type { Bus } from './bus.js';
import { emitLaneRebase, rebaseOpenLanesAfterMain } from './laneService.js';

/** A history request the caller can act on; `status` is the HTTP code the route answers with. */
export class HistoryError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'HistoryError';
  }
}

const Index = z.number().int().nonnegative();
const SlideIdSchema = z.string().min(1);
const PatchKeySchema = SlidePatchSchema.keyof();

/** A diff entry as the restore route receives it and as a restore version stores it (JSON in cause.entry). */
export const DiffEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('added'), slide: SlideIdSchema, at: Index }),
  z.object({ kind: z.literal('removed'), slide: SlideIdSchema, wasAt: Index }),
  z.object({ kind: z.literal('modified'), slide: SlideIdSchema, fields: z.array(PatchKeySchema) }),
  z.object({ kind: z.literal('moved'), slide: SlideIdSchema, from: Index, to: Index }),
]);

/** The entry a restore version stored, or null when it does not read as one. */
export function storedEntry(raw: string): DiffEntry | null {
  try {
    const parsed = DiffEntrySchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as DiffEntry) : null;
  } catch {
    return null;
  }
}

const PATCH_FIELDS = ['title', 'story', 'notes', 'body', 'assets', 'kind'] as const satisfies readonly (keyof SlidePatch)[];

const copySlide = (s: Slide): Slide => ({ ...s, assets: [...s.assets] });

function patchOf(from: Slide, to: Slide): SlidePatch {
  const patch: SlidePatch = {};
  for (const f of PATCH_FIELDS) {
    if (f === 'assets') {
      if (from.assets.length !== to.assets.length || from.assets.some((a, i) => a !== to.assets[i])) patch.assets = [...to.assets];
    } else if (from[f] !== to[f]) {
      Object.assign(patch, { [f]: to[f] });
    }
  }
  return patch;
}

const pick = (patch: SlidePatch, fields: readonly (keyof SlidePatch)[]): SlidePatch =>
  Object.fromEntries(Object.entries(patch).filter(([f]) => fields.includes(f as keyof SlidePatch))) as SlidePatch;

/** Order with `id` placed so that it ends up at index `at` (clamped to the end). `order` must not contain `id`. */
function placeAt(order: readonly SlideId[], id: SlideId, at: number): SlideId[] {
  const i = Math.max(0, Math.min(at, order.length));
  return [...order.slice(0, i), id, ...order.slice(i)];
}

/**
 * What a restore did, for the version line: the slide by its number and title, and the version it went back to.
 * `before` is main just before the restore, `after` the restore version. A removed slide is numbered where it was;
 * the others where they are after the restore.
 */
export function describeRestore(from: number, entry: DiffEntry, before: Snapshot, after: Snapshot): string {
  const ref = (s: Snapshot): string => {
    const i = s.order.indexOf(entry.slide);
    const title = s.slides[entry.slide]?.title;
    return i < 0 || title === undefined ? 'a slide' : `slide ${i + 1} (${title})`;
  };
  switch (entry.kind) {
    case 'added':
      return `removed ${ref(before)}, back to v${from}`;
    case 'removed':
      return `brought back ${ref(after)} from v${from}`;
    case 'modified':
      return `reverted ${entry.fields.join(', ') || 'content'} of ${ref(after)} to v${from}`;
    case 'moved':
      return `moved ${ref(after)} back to v${from}`;
  }
}

export class HistoryService {
  constructor(
    private readonly store: DeckStore,
    private readonly bus: Bus,
  ) {}

  async diff(a: number, b: number): Promise<DiffEntry[]> {
    const known = new Set((await this.store.versions()).map((v) => v.n));
    for (const n of [a, b]) if (!known.has(n)) throw new HistoryError(400, `version ${n} does not exist`);
    return diffVersions(await this.store.snapshotAt(a), await this.store.snapshotAt(b));
  }

  /** Applies the inverse of one diff entry (taken between v<from> and a later version) onto current main as a new version. */
  async restore(from: number, entry: DiffEntry): Promise<Version> {
    const out = await this.store.withLock(async () => {
      const past = await this.snapshotOf(from);
      const main = await this.store.snapshot();
      const next = inverse(past, main, entry);
      const version = await this.store.commit(next, { kind: 'restore', from, entry: JSON.stringify(entry) });
      // Main moved under the open lanes, exactly as after an accept.
      return { version, rebase: await rebaseOpenLanesAfterMain(this.store, next) };
    });
    this.bus.emit({ type: 'deck.changed', version: out.version.n });
    emitLaneRebase(this.bus, out.rebase);
    return out.version;
  }

  /** Opens a lane whose pending changes, accepted in order, turn current main into v<n>. */
  async openAsLane(n: number): Promise<string> {
    const lane = await this.store.withLock(async () => {
      const target = await this.snapshotOf(n);
      const [state, main] = await Promise.all([this.store.state(), this.store.snapshot()]);
      const changes = changesToward(main, target, n);
      if (changes.length === 0) throw new HistoryError(409, `main already equals v${n}`);
      const lane: Lane = {
        id: newId('l'),
        label: `back to v${n}`,
        anchor: { kind: 'arc' },
        origin: 'user',
        baseVersion: state.version,
        changes,
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      await this.store.putLane(lane);
      return lane;
    });
    this.bus.emit({ type: 'lane.created', laneId: lane.id });
    return lane.id;
  }

  private async snapshotOf(n: number): Promise<Snapshot> {
    if (!(await this.store.versions()).some((v) => v.n === n)) throw new HistoryError(400, `version ${n} does not exist`);
    return this.store.snapshotAt(n);
  }
}

const stale = (msg: string): HistoryError => new HistoryError(409, `entry no longer applies: ${msg}`);

function inverse(past: Snapshot, main: Snapshot, entry: DiffEntry): Snapshot {
  const id = entry.slide;
  const then = past.order.includes(id) ? past.slides[id] : undefined;
  const now = main.order.includes(id) ? main.slides[id] : undefined;
  switch (entry.kind) {
    case 'removed': {
      if (!then) throw stale(`slide ${id} is not in the source version`);
      if (now) throw stale(`slide ${id} is already on main`);
      return { order: placeAt(main.order, id, entry.wasAt), slides: { ...main.slides, [id]: copySlide(then) } };
    }
    case 'added': {
      if (then) throw stale(`slide ${id} exists in the source version`);
      if (!now) throw stale(`slide ${id} is not on main`);
      const { [id]: _gone, ...slides } = main.slides;
      return { order: main.order.filter((x) => x !== id), slides };
    }
    case 'modified': {
      if (!then) throw stale(`slide ${id} is not in the source version`);
      if (!now) throw stale(`slide ${id} is not on main`);
      // Only the fields the entry names go back; later edits to the other fields of the slide stay.
      const patch = pick(patchOf(now, then), entry.fields);
      if (Object.keys(patch).length === 0) throw stale(`slide ${id} already has its source ${entry.fields.join(', ') || 'content'}`);
      return { order: [...main.order], slides: { ...main.slides, [id]: { ...now, ...patch, id } } };
    }
    case 'moved': {
      if (!then) throw stale(`slide ${id} is not in the source version`);
      if (!now) throw stale(`slide ${id} is not on main`);
      const order = placeAt(main.order.filter((x) => x !== id), id, entry.from);
      if (order.indexOf(id) === main.order.indexOf(id)) throw stale(`slide ${id} is already at index ${order.indexOf(id)}`);
      return { order, slides: { ...main.slides } };
    }
  }
}

/**
 * Translates diffVersions(main, target) into lane changes. Removes and modifies first, then inserts and moves
 * in target order, each anchored after the slide preceding it in the target. Walking the target left to right
 * keeps every slide placed so far, plus the slides the diff left in place, in target order: each newly placed
 * slide lands right after its target predecessor, which is exactly between it and the next unmoved slide.
 * (Emitting all inserts before all moves would not: an insert after a slide that moves later stays behind.)
 * A placement whose target predecessor stays put is anchored on a stable slide, so it commutes with every other
 * change. Only runs of adjacent placed slides chain on each other and need list order: with `after`-only anchors
 * no fixed choice reproduces a run under every accept order (A,P1,P2 anchored all on A comes out reversed when
 * accepted in list order), so a chained insert that is accepted early fails with 409 and a chained move lands wrong.
 */
function changesToward(main: Snapshot, target: Snapshot, n: number): Change[] {
  const entries = diffVersions(main, target);
  const reason = (what: string): string => `back to v${n}: ${what}`;
  const removes: Change[] = [];
  const modifies: Change[] = [];
  const placed = new Map<SlideId, 'insert' | 'move'>();
  for (const e of entries) {
    if (e.kind === 'removed') removes.push({ id: newId('c'), kind: 'remove', slide: e.slide, reason: reason(`remove "${main.slides[e.slide]!.title}"`), status: 'pending' });
    else if (e.kind === 'added') placed.set(e.slide, 'insert');
    else if (e.kind === 'moved') placed.set(e.slide, 'move');
    else {
      const patch = patchOf(main.slides[e.slide]!, target.slides[e.slide]!);
      modifies.push({ id: newId('c'), kind: 'modify', slide: e.slide, patch, reason: reason(`restore ${e.fields.join(', ')} of "${target.slides[e.slide]!.title}"`), status: 'pending' });
    }
  }

  // An added slide keeps its id unless main already uses it (only possible if main holds the id without listing it).
  const rename = new Map<SlideId, SlideId>();
  for (const [id, kind] of placed) if (kind === 'insert' && Object.hasOwn(main.slides, id)) rename.set(id, newId('s'));
  const idOnMain = (id: SlideId): SlideId => rename.get(id) ?? id;

  const placements: Change[] = [];
  target.order.forEach((id, i) => {
    const kind = placed.get(id);
    if (!kind) return;
    const after = i === 0 ? null : idOnMain(target.order[i - 1]!);
    const s = target.slides[id]!;
    placements.push(
      kind === 'insert'
        ? { id: newId('c'), kind: 'insert', after, slide: { ...copySlide(s), id: idOnMain(id) }, reason: reason(`bring back "${s.title}"`), status: 'pending' }
        : { id: newId('c'), kind: 'move', slide: id, after, reason: reason(`move "${s.title}" back to position ${i + 1}`), status: 'pending' },
    );
  });
  return [...removes, ...modifies, ...placements];
}
