import { hashSlide, newId } from '../model/ids.js';
import { ALREADY_ON_MAIN, anchorIsStale, applyChange, rebaseLane } from '../model/ops.js';
import type { Change, Lane, Remark, SlideId, Snapshot, Version } from '../model/types.js';
import type { DeckStore } from '../store/deckStore.js';
import type { Bus } from './bus.js';

/** A lane operation the caller can act on; `status` is the HTTP code the route answers with. */
export class LaneError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'LaneError';
  }
}

export interface LanePreview {
  order: SlideId[];
  slides: Snapshot['slides'];
  /** Pending changes that no longer apply on current main (they are left out of the preview). */
  skipped: string[];
  /** Slides whose content differs from main: the ones whose thumbnails the lane row needs. */
  changed: SlideId[];
}

const hasPending = (l: Lane): boolean => l.changes.some((c) => c.status === 'pending');

/**
 * Resolves the open remarks found on the preview of the given (now closed) lanes: they described slides
 * that only existed in that lane. Null when nothing changes.
 */
export function resolveLaneRemarks(remarks: readonly Remark[], closedLaneIds: readonly string[]): Remark[] | null {
  if (closedLaneIds.length === 0) return null;
  let changed = false;
  const next = remarks.map((r) => {
    if (r.status !== 'open' || !r.sourceLaneId || !closedLaneIds.includes(r.sourceLaneId)) return r;
    changed = true;
    return { ...r, status: 'resolved' as const };
  });
  return changed ? next : null;
}

/**
 * Resolves the open remarks about main whose anchor no longer matches `order`: a slide that left main, or a range a
 * move reversed. Their wording described a deck that is gone; the next run of their check reports on the new one.
 * Remarks found on a lane preview are left alone (their anchor lives in the preview's order). Null when nothing changes.
 */
export function resolveStaleRemarks(remarks: readonly Remark[], order: readonly SlideId[]): Remark[] | null {
  let changed = false;
  const next = remarks.map((r) => {
    if (r.status !== 'open' || r.sourceLaneId || !anchorIsStale(order, r.anchor)) return r;
    changed = true;
    return { ...r, status: 'resolved' as const };
  });
  return changed ? next : null;
}

/** Open lanes rewritten after main moved; `remarksChanged` when some remark was resolved (closed lane, stale anchor). */
export interface LaneRebase {
  lanes: Lane[];
  remarksChanged: boolean;
}

/** Main at the lane's base version; main itself when that version cannot be read (no staleness is then detected). */
async function baseOf(store: DeckStore, n: number, main: Snapshot, cache: Map<number, Snapshot>): Promise<Snapshot> {
  const hit = cache.get(n);
  if (hit) return hit;
  const snap = await store.snapshotAt(n).catch(() => main);
  cache.set(n, snap);
  return snap;
}

/** "slide N (title)" on main, the quoted title of a slide main no longer has, or "a slide". */
function slideLabel(id: SlideId, main: Snapshot, base: Snapshot): string {
  const i = main.order.indexOf(id);
  if (i >= 0) return `slide ${i + 1} (${main.slides[id]!.title})`;
  const was = base.slides[id];
  return was ? `the slide "${was.title}"` : 'a slide';
}

function describeChange(c: Change, main: Snapshot, base: Snapshot): string {
  switch (c.kind) {
    case 'modify':
      return `the ${listOf(Object.keys(c.patch))} of ${slideLabel(c.slide, main, base)}`;
    case 'insert':
      return `the new slide "${c.slide.title}"`;
    case 'remove':
      return `removing ${slideLabel(c.slide, main, base)}`;
    case 'move':
      return `moving ${slideLabel(c.slide, main, base)}`;
  }
}

const listOf = (xs: readonly string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)!}`);
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One line per change the rebase decided, then whether the lane closed; null when nothing was decided. */
export function rebaseNote(next: Lane, causes: Record<string, string>, main: Snapshot, base: Snapshot): string | null {
  const lines = next.changes.flatMap((c) => {
    const cause = causes[c.id];
    if (cause === undefined) return [];
    const what = capitalize(describeChange(c, main, base));
    return [cause === ALREADY_ON_MAIN ? `${what}: already on main, nothing to decide.` : `${what} no longer applies: ${cause}.`];
  });
  if (lines.length === 0) return null;
  if (next.status === 'closed') lines.push('Nothing is left to decide in this lane, so it is closed.');
  return lines.join(' ');
}

/**
 * Call under the deck lock. Re-judges the lane's pending changes on `main` (see rebaseLane), closes it when nothing is
 * left pending, and records in the lane's thread why changes were decided. Does not write the lane.
 */
export async function rebaseOnMain(store: DeckStore, lane: Lane, main: Snapshot, cache = new Map<number, Snapshot>()): Promise<Lane> {
  const base = await baseOf(store, lane.baseVersion, main, cache);
  const { lane: rebased, causes } = rebaseLane(lane, main, base);
  const next: Lane = hasPending(rebased) ? rebased : { ...rebased, status: 'closed' };
  const note = rebaseNote(next, causes, main, base);
  if (note) await store.appendMessage({ id: newId('m'), thread: `lane:${lane.id}`, role: 'assistant', text: note, context: null, at: new Date().toISOString() });
  return next;
}

/**
 * Call under the deck lock right after a commit moved main to `main` (or whenever main may have moved under the
 * lanes). Rebases every open lane on it (orphaning stale changes, accepting those already on main), closes lanes
 * left without a pending change and resolves their remarks, and resolves remarks whose anchor main no longer matches.
 * `touched` is a lane the caller already modified (the one whose change was just accepted): it is always written
 * and listed first. Draft lanes are rebased too (they may end up closed) but otherwise stay drafts.
 * Idempotent: a second call on the same main changes nothing and writes no thread note.
 */
export async function rebaseOpenLanesAfterMain(store: DeckStore, main: Snapshot, touched?: Lane): Promise<LaneRebase> {
  // Drafts are rebased like open lanes: main moved under them too.
  const others = (await store.lanes()).filter((l) => l.status !== 'closed' && l.id !== touched?.id);
  const lanes: Lane[] = [];
  const cache = new Map<number, Snapshot>();
  for (const l of touched ? [touched, ...others] : others) {
    const next = await rebaseOnMain(store, l, main, cache);
    if (l !== touched && JSON.stringify(next) === JSON.stringify(l)) continue;
    await store.putLane(next);
    lanes.push(next);
  }
  const remarks = await store.remarks();
  const ofLanes = resolveLaneRemarks(remarks, lanes.filter((l) => l.status === 'closed').map((l) => l.id)) ?? remarks;
  const resolved = resolveStaleRemarks(ofLanes, main.order) ?? ofLanes;
  if (resolved !== remarks) await store.putRemarks(resolved);
  return { lanes, remarksChanged: resolved !== remarks };
}

/** Emits what a rebase changed. Call after releasing the deck lock, once deck.changed went out. */
export function emitLaneRebase(bus: Bus, r: LaneRebase): void {
  for (const l of r.lanes) emitLane(bus, l);
  if (r.remarksChanged) bus.emit({ type: 'remarks.changed' });
}

function emitLane(bus: Bus, lane: Lane): void {
  bus.emit({ type: 'lane.updated', laneId: lane.id });
  if (lane.status === 'closed') bus.emit({ type: 'lane.closed', laneId: lane.id });
}

/** Quiet period after the last deck.changed before the lanes are rebased on main. */
export const LANE_SYNC_DEBOUNCE_MS = 100;

/**
 * Every lane mutation runs under the deck lock, so accepts are strictly sequential
 * and each one applies on top of the previous commit (Review Focus 5).
 * Lanes follow main: every deck change schedules a rebase (scheduleSync), and reads rebase first when main moved
 * since the last one (syncWithMain), so a lane is never served as judged on an older main, whoever moved it.
 */
export class LaneService {
  /** Deck version the lanes were last rebased on, in this process. Null: not yet. */
  private rebasedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly store: DeckStore,
    private readonly bus: Bus,
    private readonly debounceMs = LANE_SYNC_DEBOUNCE_MS,
  ) {}

  /**
   * Rebases every open and draft lane on main (and resolves the remarks it leaves stale) unless that was already
   * done for the current version. Emits what changed.
   */
  async syncWithMain(): Promise<void> {
    const rebase = await this.store.withLock(async () => {
      const { version } = await this.store.state();
      if (version === this.rebasedAt) return null;
      const out = await rebaseOpenLanesAfterMain(this.store, await this.store.snapshot());
      this.rebasedAt = version;
      return out;
    });
    if (rebase) emitLaneRebase(this.bus, rebase);
  }

  /** Debounced syncWithMain, for deck.changed: a burst of changes costs one rebase. */
  scheduleSync(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed) return;
      this.syncWithMain().catch((e: unknown) => console.error(`[lanes] rebase after a deck change failed: ${e instanceof Error ? e.message : String(e)}`));
    }, this.debounceMs);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async accept(laneId: string, changeId: string): Promise<{ version: Version; lane: Lane }> {
    const out = await this.store.withLock(async () => {
      const lane = await this.actionableLane(laneId);
      const change = this.pendingChange(lane, changeId);
      const res = applyChange(await this.store.snapshot(), change);
      if (!res.ok) throw new LaneError(409, `change ${changeId} no longer applies on main: ${res.error}`);
      const version = await this.store.commit(res.next, { kind: 'accept', laneId, changeId });

      // Acting on a draft opens it.
      const accepted: Lane = { ...this.withStatus(lane, changeId, 'accepted'), status: 'open' };
      const rebase = await rebaseOpenLanesAfterMain(this.store, res.next, accepted);
      this.rebasedAt = version.n;
      return { version, rebase };
    });

    this.bus.emit({ type: 'deck.changed', version: out.version.n });
    emitLaneRebase(this.bus, out.rebase);
    return { version: out.version, lane: out.rebase.lanes[0]! };
  }

  async refuse(laneId: string, changeId: string): Promise<Lane> {
    const out = await this.store.withLock(async () => {
      const lane = await this.actionableLane(laneId);
      this.pendingChange(lane, changeId);
      const refused: Lane = { ...this.withStatus(lane, changeId, 'refused'), status: 'open' };
      // Main may have moved since the lane was last judged: what is left pending is re-judged on it.
      const next = await rebaseOnMain(this.store, refused, await this.store.snapshot());
      await this.store.putLane(next);
      const remarksChanged = next.status === 'closed' && (await this.resolveRemarksOf([next.id]));
      return { next, remarksChanged };
    });
    emitLane(this.bus, out.next);
    if (out.remarksChanged) this.bus.emit({ type: 'remarks.changed' });
    return out.next;
  }

  /** Shows a draft (proposed by a check) on main. Opening an open lane is a no-op; a closed lane cannot be reopened. */
  async open(laneId: string): Promise<Lane> {
    const out = await this.store.withLock(async () => {
      const lane = await this.store.lane(laneId);
      if (!lane) throw new LaneError(404, `unknown lane ${laneId}`);
      if (lane.status === 'closed') throw new LaneError(409, `lane ${laneId} is closed`);
      if (lane.status === 'open') return { lane, changed: false, remarksChanged: false };
      // A draft may have waited while main moved: it opens judged on current main, and closes if nothing is left.
      const next = await rebaseOnMain(this.store, { ...lane, status: 'open' }, await this.store.snapshot());
      await this.store.putLane(next);
      const remarksChanged = next.status === 'closed' && (await this.resolveRemarksOf([next.id]));
      return { lane: next, changed: true, remarksChanged };
    });
    if (out.changed) {
      emitLane(this.bus, out.lane);
      if (out.lane.status === 'open') this.bus.emit({ type: 'lane.opened', laneId });
    }
    if (out.remarksChanged) this.bus.emit({ type: 'remarks.changed' });
    return out.lane;
  }

  async closeLane(laneId: string): Promise<void> {
    const closed = await this.store.withLock(async () => {
      const lane = await this.store.lane(laneId);
      if (!lane) throw new LaneError(404, `unknown lane ${laneId}`);
      if (lane.status === 'closed') return null;
      await this.store.putLane({ ...lane, status: 'closed' });
      return { remarksChanged: await this.resolveRemarksOf([laneId]) };
    });
    if (!closed) return;
    this.bus.emit({ type: 'lane.closed', laneId });
    if (closed.remarksChanged) this.bus.emit({ type: 'remarks.changed' });
  }

  /** Current main with all pending changes of the lane applied in order. Read under the lock so a concurrent commit is never seen half-written. */
  async preview(laneId: string): Promise<LanePreview> {
    return this.store.withLock(async () => {
      const lane = await this.store.lane(laneId);
      if (!lane) throw new LaneError(404, `unknown lane ${laneId}`);
      const main = await this.store.snapshot();
      let snap = main;
      const skipped: string[] = [];
      for (const c of lane.changes) {
        if (c.status !== 'pending') continue;
        const res = applyChange(snap, c);
        if (res.ok) snap = res.next;
        else skipped.push(c.id);
      }
      const changed = snap.order.filter((id) => {
        const before = main.slides[id];
        return before === undefined || hashSlide(before) !== hashSlide(snap.slides[id]!);
      });
      return { order: snap.order, slides: snap.slides, skipped, changed };
    });
  }

  /** Call under the deck lock. True when some remark was resolved. */
  private async resolveRemarksOf(closedLaneIds: string[]): Promise<boolean> {
    const next = resolveLaneRemarks(await this.store.remarks(), closedLaneIds);
    if (next) await this.store.putRemarks(next);
    return next !== null;
  }

  /** An open or draft lane: the creator may accept or refuse its changes. */
  private async actionableLane(laneId: string): Promise<Lane> {
    const lane = await this.store.lane(laneId);
    if (!lane) throw new LaneError(404, `unknown lane ${laneId}`);
    if (lane.status === 'closed') throw new LaneError(409, `lane ${laneId} is closed`);
    return lane;
  }

  private pendingChange(lane: Lane, changeId: string): Change {
    const change = lane.changes.find((c) => c.id === changeId);
    if (!change) throw new LaneError(404, `unknown change ${changeId} in lane ${lane.id}`);
    if (change.status !== 'pending') throw new LaneError(409, `change ${changeId} is ${change.status}, not pending`);
    return change;
  }

  private withStatus(lane: Lane, changeId: string, status: 'accepted' | 'refused'): Lane {
    return { ...lane, changes: lane.changes.map((c) => (c.id === changeId ? { ...c, status } : c)) };
  }
}
