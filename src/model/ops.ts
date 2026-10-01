import { hashSlide } from './ids.js';
import type { Anchor, Change, DiffEntry, Lane, Slide, SlideId, SlidePatch, Snapshot } from './types.js';

export type { Snapshot } from './types.js';
export type ApplyResult = { ok: true; next: Snapshot } | { ok: false; error: string };

const fail = (error: string): ApplyResult => ({ ok: false, error });

/** Returns a new order with `id` placed right after `after` (null = first). `after` must be in `order`. */
function placeAfter(order: readonly SlideId[], id: SlideId, after: SlideId | null): SlideId[] {
  if (after === null) return [id, ...order];
  const i = order.indexOf(after);
  return [...order.slice(0, i + 1), id, ...order.slice(i + 1)];
}

const has = (snap: Snapshot, id: SlideId): boolean => Object.hasOwn(snap.slides, id) && snap.order.includes(id);

export function applyChange(snap: Snapshot, change: Change): ApplyResult {
  switch (change.kind) {
    case 'insert': {
      const id = change.slide.id;
      if (Object.hasOwn(snap.slides, id) || snap.order.includes(id)) return fail(`slide ${id} already exists`);
      if (change.after !== null && !has(snap, change.after)) return fail(`unknown slide ${change.after} (insert after)`);
      return {
        ok: true,
        next: { order: placeAfter(snap.order, id, change.after), slides: { ...snap.slides, [id]: { ...change.slide, assets: [...change.slide.assets] } } },
      };
    }
    case 'modify': {
      const current = snap.slides[change.slide];
      if (current === undefined || !snap.order.includes(change.slide)) return fail(`unknown slide ${change.slide} (modify)`);
      const patch: SlidePatch = Object.fromEntries(Object.entries(change.patch).filter(([, v]) => v !== undefined));
      const next: Slide = { ...current, ...patch, id: current.id };
      return { ok: true, next: { order: [...snap.order], slides: { ...snap.slides, [change.slide]: next } } };
    }
    case 'remove': {
      if (!has(snap, change.slide)) return fail(`unknown slide ${change.slide} (remove)`);
      const { [change.slide]: _removed, ...slides } = snap.slides;
      return { ok: true, next: { order: snap.order.filter((id) => id !== change.slide), slides } };
    }
    case 'move': {
      if (!has(snap, change.slide)) return fail(`unknown slide ${change.slide} (move)`);
      if (change.after === change.slide) return fail(`cannot move slide ${change.slide} after itself`);
      if (change.after !== null && !has(snap, change.after)) return fail(`unknown slide ${change.after} (move after)`);
      const without = snap.order.filter((id) => id !== change.slide);
      return { ok: true, next: { order: placeAfter(without, change.slide, change.after), slides: { ...snap.slides } } };
    }
  }
}

/** Slide ids a change needs to exist in the deck at apply time. */
function referencedSlides(change: Change): SlideId[] {
  switch (change.kind) {
    case 'insert':
      return change.after === null ? [] : [change.after];
    case 'modify':
    case 'remove':
      return [change.slide];
    case 'move':
      return change.after === null ? [change.slide] : [change.slide, change.after];
  }
}

/** True when `change` is a move that would leave `snap` as it is: its slide already sits right after `after`. */
function isNoOpMove(snap: Snapshot, change: Change): boolean {
  if (change.kind !== 'move') return false;
  const i = snap.order.indexOf(change.slide);
  if (i < 0) return false;
  return change.after === null ? i === 0 : i > 0 && snap.order[i - 1] === change.after;
}

/**
 * Marks as 'orphan' the pending changes that no longer mean anything on `snap`: those whose referenced slides no
 * longer exist, and moves whose slide already sits at its target. A slide inserted by an earlier live
 * (pending/accepted) change of the same lane counts as existing, so "insert n1, then insert after n1" survives,
 * and a move is judged on main as the lane's earlier pending changes leave it. Non-pending changes are left untouched.
 */
export function rebaseLane(lane: Lane, snap: Snapshot): Lane {
  const known = new Set<SlideId>(snap.order.filter((id) => Object.hasOwn(snap.slides, id)));
  // Main with the lane's surviving pending changes applied so far: where a move would start from.
  let sim = snap;
  const changes = lane.changes.map((c): Change => {
    if (c.status !== 'pending') {
      if (c.kind === 'insert' && c.status === 'accepted') known.add(c.slide.id);
      return c;
    }
    const orphan = referencedSlides(c).some((id) => !known.has(id)) || isNoOpMove(sim, c);
    if (orphan) return { ...c, status: 'orphan' };
    if (c.kind === 'insert') known.add(c.slide.id);
    const r = applyChange(sim, c);
    if (r.ok) sim = r.next;
    return c;
  });
  return { ...lane, changes };
}

const PATCH_FIELDS = ['title', 'story', 'notes', 'body', 'assets', 'kind'] as const satisfies readonly (keyof SlidePatch)[];

function fieldEqual(a: Slide, b: Slide, f: (typeof PATCH_FIELDS)[number]): boolean {
  if (f === 'assets') return a.assets.length === b.assets.length && a.assets.every((x, i) => x === b.assets[i]);
  return a[f] === b[f];
}

/** Indices of one longest strictly increasing subsequence of `xs` (patience sorting, O(n log n)). */
function longestIncreasing(xs: readonly number[]): number[] {
  const tails: number[] = []; // tails[k] = index in xs of the smallest tail of an increasing run of length k+1
  const prev: number[] = new Array<number>(xs.length).fill(-1);
  xs.forEach((x, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[tails[mid]!]! < x) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const out: number[] = [];
  for (let i = tails.length > 0 ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) out.push(i);
  return out.reverse();
}

/**
 * Diff by slide id. Entries are emitted as: removed (in a's order), added, modified, moved (in b's order).
 * Among slides present in both snapshots, the longest run that kept its relative order stays put;
 * every other common slide is 'moved'. This is a minimal move set, and pure insertions/removals never produce moves.
 */
export function diffVersions(a: Snapshot, b: Snapshot): DiffEntry[] {
  const inA = new Set(a.order);
  const inB = new Set(b.order);
  const removed: DiffEntry[] = a.order.flatMap((id, i) => (inB.has(id) ? [] : [{ kind: 'removed' as const, slide: id, wasAt: i }]));
  const added: DiffEntry[] = b.order.flatMap((id, i) => (inA.has(id) ? [] : [{ kind: 'added' as const, slide: id, at: i }]));

  const modified: DiffEntry[] = b.order.flatMap((id) => {
    const sa = a.slides[id];
    const sb = b.slides[id];
    if (!inA.has(id) || sa === undefined || sb === undefined || hashSlide(sa) === hashSlide(sb)) return [];
    const fields = PATCH_FIELDS.filter((f) => !fieldEqual(sa, sb, f));
    return [{ kind: 'modified' as const, slide: id, fields }];
  });

  const commonA = a.order.filter((id) => inB.has(id));
  const commonB = b.order.filter((id) => inA.has(id));
  const rankA = new Map(commonA.map((id, i) => [id, i]));
  const kept = new Set(longestIncreasing(commonB.map((id) => rankA.get(id)!)).map((i) => commonB[i]!));
  const moved: DiffEntry[] = commonB.flatMap((id) =>
    kept.has(id) ? [] : [{ kind: 'moved' as const, slide: id, from: a.order.indexOf(id), to: b.order.indexOf(id) }],
  );

  return [...removed, ...added, ...modified, ...moved];
}

const FORBIDDEN: readonly [RegExp, string][] = [
  [/<\s*ul\b/i, 'body contains <ul>; lists are not allowed, use layout blocks instead'],
  [/<\s*ol\b/i, 'body contains <ol>; lists are not allowed, use layout blocks instead'],
  [/<\s*script\b/i, 'body contains <script>; scripts are not allowed'],
];

export function validateBody(body: string): { ok: true } | { ok: false; reasons: string[] } {
  if (body.trim() === '') return { ok: false, reasons: ['body is empty'] };
  const reasons = FORBIDDEN.filter(([re]) => re.test(body)).map(([, msg]) => msg);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** slide → [id]; range → contiguous ids from..to inclusive (swapped if reversed; [] if a bound is unknown); arc → all. */
export function slidesInRange(order: SlideId[], anchor: Anchor): SlideId[] {
  switch (anchor.kind) {
    case 'slide':
      return [anchor.slide];
    case 'arc':
      return [...order];
    case 'range': {
      const i = order.indexOf(anchor.from);
      const j = order.indexOf(anchor.to);
      if (i < 0 || j < 0) return [];
      return order.slice(Math.min(i, j), Math.max(i, j) + 1);
    }
  }
}
