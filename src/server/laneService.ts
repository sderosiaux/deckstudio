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
      const lane = await this.openLane(laneId);
      const change = this.pendingChange(lane, changeId);
      const res = applyChange(await this.store.snapshot(), change);
      if (!res.ok) throw new LaneError(409, `change ${changeId} no longer applies on main: ${res.error}`);
      const version = await this.store.commit(res.next, { kind: 'accept', laneId, changeId });

      const accepted = this.withStatus(lane, changeId, 'accepted');
      const others = (await this.store.lanes()).filter((l) => l.status === 'open' && l.id !== laneId);
      const touched: { lane: Lane; changed: boolean }[] = [];
      for (const l of [accepted, ...others]) {
        const rebased = rebaseLane(l, res.next);
        const next: Lane = hasPending(rebased) ? rebased : { ...rebased, status: 'closed' };
        const changed = l === accepted || JSON.stringify(next) !== JSON.stringify(l);
        if (changed) await this.store.putLane(next);
        touched.push({ lane: next, changed });
      }
      const remarksChanged = await this.resolveRemarksOf(touched.filter((t) => t.changed && t.lane.status === 'closed').map((t) => t.lane.id));
      return { version, touched, remarksChanged };
    });

    this.bus.emit({ type: 'deck.changed', version: out.version.n });
    for (const { lane, changed } of out.touched) if (changed) this.emitLane(lane);
    if (out.remarksChanged) this.bus.emit({ type: 'remarks.changed' });
    return { version: out.version, lane: out.touched[0]!.lane };
  }

  async refuse(laneId: string, changeId: string): Promise<Lane> {
    const out = await this.store.withLock(async () => {
      const lane = await this.openLane(laneId);
      this.pendingChange(lane, changeId);
      const refused = this.withStatus(lane, changeId, 'refused');
      const next: Lane = hasPending(refused) ? refused : { ...refused, status: 'closed' };
      await this.store.putLane(next);
      const remarksChanged = next.status === 'closed' && (await this.resolveRemarksOf([next.id]));
      return { next, remarksChanged };
    });
    this.emitLane(out.next);
    if (out.remarksChanged) this.bus.emit({ type: 'remarks.changed' });
    return out.next;
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

  private async openLane(laneId: string): Promise<Lane> {
    const lane = await this.store.lane(laneId);
    if (!lane) throw new LaneError(404, `unknown lane ${laneId}`);
    if (lane.status !== 'open') throw new LaneError(409, `lane ${laneId} is closed`);
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

  private emitLane(lane: Lane): void {
    this.bus.emit({ type: 'lane.updated', laneId: lane.id });
    if (lane.status === 'closed') this.bus.emit({ type: 'lane.closed', laneId: lane.id });
  }
}
