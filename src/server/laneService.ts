import { hashSlide } from '../model/ids.js';
import { applyChange, rebaseLane } from '../model/ops.js';
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

/** Open lanes rewritten after main moved; `remarksChanged` when some remark of a now-closed lane was resolved. */
export interface LaneRebase {
  lanes: Lane[];
  remarksChanged: boolean;
}

/**
 * Call under the deck lock right after a commit moved main to `main`. Rebases every open lane on it (orphaning changes
 * that no longer apply), closes lanes left without a pending change and resolves their remarks. `touched` is a lane
 * the caller already modified (the one whose change was just accepted): it is always written and listed first.
 * Draft lanes are rebased too (they may end up closed) but otherwise stay drafts.
 */
export async function rebaseOpenLanesAfterMain(store: DeckStore, main: Snapshot, touched?: Lane): Promise<LaneRebase> {
  // Drafts are rebased like open lanes: main moved under them too.
  const others = (await store.lanes()).filter((l) => l.status !== 'closed' && l.id !== touched?.id);
  const lanes: Lane[] = [];
  for (const l of touched ? [touched, ...others] : others) {
    const rebased = rebaseLane(l, main);
    const next: Lane = hasPending(rebased) ? rebased : { ...rebased, status: 'closed' };
    if (l !== touched && JSON.stringify(next) === JSON.stringify(l)) continue;
    await store.putLane(next);
    lanes.push(next);
  }
  const resolved = resolveLaneRemarks(await store.remarks(), lanes.filter((l) => l.status === 'closed').map((l) => l.id));
  if (resolved) await store.putRemarks(resolved);
  return { lanes, remarksChanged: resolved !== null };
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

/**
 * Every lane mutation runs under the deck lock, so accepts are strictly sequential
 * and each one applies on top of the previous commit (Review Focus 5).
 */
export class LaneService {
  constructor(
    private readonly store: DeckStore,
    private readonly bus: Bus,
  ) {}

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
      const next: Lane = hasPending(refused) ? refused : { ...refused, status: 'closed' };
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
      if (lane.status === 'open') return { lane, changed: false };
      const next: Lane = { ...lane, status: 'open' };
      await this.store.putLane(next);
      return { lane: next, changed: true };
    });
    if (out.changed) {
      this.bus.emit({ type: 'lane.updated', laneId });
      this.bus.emit({ type: 'lane.opened', laneId });
    }
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
