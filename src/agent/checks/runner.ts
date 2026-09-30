import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { newId } from '../../model/ids.js';
import { slidesInRange } from '../../model/ops.js';
import type { Anchor, Brief, Lane, Remark, SlideId, Snapshot } from '../../model/types.js';
import type { ThumbService } from '../../render/thumbs.js';
import type { Bus } from '../../server/bus.js';
import { LaneService, resolveLaneRemarks } from '../../server/laneService.js';
import type { DeckStore } from '../../store/deckStore.js';
import { makeDeckToolHandlers, type DeckToolHandlers } from '../tools.js';
import { arc } from './arc.js';
import { gaps } from './gaps.js';
import { CHECK_NAMES, CheckResultSchema, isCheckName, type CheckDef, type CheckName, type CheckResult, type ChecksStatus } from './index.js';
import { order } from './order.js';
import { render } from './render.js';

export { CheckResultSchema, type CheckDef, type CheckName, type ChecksStatus } from './index.js';

export const CHECKS: Readonly<Record<CheckName, CheckDef>> = { arc, order, gaps, render };

export const RETRY_INSTRUCTION = 'Return only the JSON object';
const DEFAULT_DEBOUNCE_MS = 3000;
/** Checks that Read thumbnails need a few turns (read images, then answer); the others answer in one. */
const THUMB_CHECK_MAX_TURNS = 6;

export interface CheckRunnerOptions {
  store: DeckStore;
  thumbs: ThumbService;
  bus: Bus;
  model: string;
  queryImpl?: typeof query;
  /** Quiet period after the last accept before all checks run. */
  debounceMs?: number;
}

export interface CheckRunResult {
  remarks: Remark[];
  lanes: Lane[];
}

type Item = CheckResult['remarks'][number];
type Outcome = { ok: true; items: Item[] } | { ok: false; reason: string };

/** What one run looks at and which remarks it owns. */
interface Target {
  def: CheckDef;
  brief: Brief;
  /** Slides shown to the model. */
  snap: Snapshot;
  /** Slide ids a remark anchor may reference. */
  validIds: ReadonlySet<SlideId>;
  /** Order used to resolve range anchors when deciding which old remarks are in scope. */
  order: readonly SlideId[];
  allowLanes: boolean;
  /** Set for a render check on a lane's preview: its remarks carry it as sourceLaneId. */
  laneId: string | null;
  /** Null: the run covers the whole deck and replaces all of its check's remarks. */
  scopeIds: ReadonlySet<SlideId> | null;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const STOPPED = 'check runner stopped';
const failurePrefix = (name: CheckName): string => `check ${name} failed: `;
/** The single remark a failed run leaves (per check, per scanned lane). */
const isFailureRemark = (r: Remark, name: CheckName): boolean =>
  r.anchor.kind === 'arc' && r.severity === 'info' && r.laneId === null && r.text.startsWith(failurePrefix(name));
const pick = (snap: Snapshot, ids: readonly SlideId[]): Snapshot => ({
  order: ids.filter((id) => snap.slides[id] !== undefined),
  slides: Object.fromEntries(ids.flatMap((id) => (snap.slides[id] ? [[id, snap.slides[id]!]] : []))),
});

function anchorIds(a: Anchor): SlideId[] {
  return a.kind === 'slide' ? [a.slide] : a.kind === 'range' ? [a.from, a.to] : [];
}

/** The first `{` to the last `}` of the answer, parsed and validated; anchors must name known slides. */
export function parseCheckOutput(text: string, validIds: ReadonlySet<SlideId>): Outcome {
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i < 0 || j < i) return { ok: false, reason: 'the answer contains no JSON object' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(i, j + 1));
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${errorMessage(e)}` };
  }
  const parsed = CheckResultSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((iss) => `${iss.path.map(String).join('.') || '(root)'}: ${iss.message}`);
    return { ok: false, reason: `the JSON does not match the contract: ${issues.join('; ')}` };
  }
  const unknown = parsed.data.remarks.flatMap((r, k) => {
    const bad = anchorIds(r.anchor).filter((id) => !validIds.has(id));
    return bad.length ? [`remarks.${k}.anchor names unknown slide id(s) ${bad.join(', ')}`] : [];
  });
  if (unknown.length) return { ok: false, reason: unknown.join('; ') };
  return { ok: true, items: parsed.data.remarks };
}

/**
 * Runs the deck checks as fresh single-shot SDK queries (no session, no user settings), validates their
 * JSON, and persists the result as remarks that replace the check's previous ones. Runs are serialized:
 * at most one check query is in flight per deck. The runner is the only owner of check status: which
 * checks are queued or running, and when each last ended (in memory: a restart forgets it).
 */
export class CheckRunner {
  private readonly opts: CheckRunnerOptions;
  private readonly queryImpl: typeof query;
  private readonly handlers: DeckToolHandlers;
  private tail: Promise<unknown> = Promise.resolve();
  /** Queued or running runs per check name (deck-wide, scoped and lane runs alike). */
  private readonly active = new Map<CheckName, number>();
  /** The queued or running deck-wide run of each check, which a new unscoped run of that name joins. */
  private readonly pending = new Map<CheckName, Promise<CheckRunResult>>();
  private readonly lastRun: Record<CheckName, string | null> = { arc: null, order: null, gaps: null, render: null };
  /** The after-accept batch queued or running; an accept meanwhile only marks it dirty. */
  private batch: Promise<void> | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: AbortController | null = null;
  private disposed = false;

  constructor(opts: CheckRunnerOptions) {
    this.opts = opts;
    this.queryImpl = opts.queryImpl ?? query;
    // Only propose_lane is used: lanes attached to remarks go through the same validation as the co-author's.
    this.handlers = makeDeckToolHandlers({
      store: opts.store,
      thumbs: opts.thumbs,
      bus: opts.bus,
      imageGen: async () => {
        throw new Error('image generation is not available to checks');
      },
      runCheck: async () => {
        throw new Error('checks cannot start other checks');
      },
    });
  }

  /**
   * Runs one check after any queued run. An unscoped run joins the deck-wide run of the same check that is
   * already queued or running instead of starting another. `scope` restricts the slides shown and the remarks replaced.
   */
  run(name: CheckName, scope?: Anchor): Promise<CheckRunResult> {
    if (scope === undefined) {
      const joined = this.pending.get(name);
      if (joined) return joined;
    }
    const p = this.tracked(name, () => this.runDeck(name, scope));
    if (scope === undefined) {
      this.pending.set(name, p);
      const clear = () => {
        if (this.pending.get(name) === p) this.pending.delete(name);
      };
      p.then(clear, clear);
    }
    return p;
  }

  /** Fire-and-forget start of the named checks not already queued or running; returns the ones started. */
  start(names: readonly CheckName[]): CheckName[] {
    if (this.disposed) return [];
    const started = [...new Set(names)].filter((n) => !this.pending.has(n));
    for (const name of started) this.run(name).catch((e) => this.report(name, e));
    return started;
  }

  /** Fire-and-forget start by name, for the run_check tool. Throws on an unknown name. */
  trigger(name: string): void {
    if (!isCheckName(name)) throw new Error(`unknown check "${name}"; available: ${CHECK_NAMES.join(', ')}`);
    this.start([name]);
  }

  status(): ChecksStatus {
    return { running: CHECK_NAMES.filter((n) => this.active.has(n)), lastRun: { ...this.lastRun } };
  }

  scheduleAfterAccept(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.batch) this.dirty = true;
      else this.runBatch();
    }, this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  scheduleAfterLane(laneId: string): void {
    if (this.disposed) return;
    this.tracked('render', () => this.runLane(laneId)).catch((e) => this.report(`render on lane ${laneId}`, e));
  }

  /** Stops pending schedules and aborts the query in flight. */
  dispose(): void {
    this.disposed = true;
    this.dirty = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current?.abort();
  }

  // -------------------------------------------------------------------------

  /** All four checks on the current deck; accepts that land meanwhile add exactly one more batch. */
  private runBatch(): void {
    const all = CHECK_NAMES.map((name) => this.run(name).catch((e) => this.report(name, e)));
    this.batch = Promise.all(all).then(() => {
      this.batch = null;
      if (this.dirty && !this.disposed) {
        this.dirty = false;
        this.runBatch();
      }
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(() => {
      if (this.disposed) throw new Error(STOPPED);
      return fn();
    });
    this.tail = p.catch(() => undefined);
    return p;
  }

  /** Enqueues `fn`, counting `name` as running from now until it settles. */
  private tracked<T>(name: CheckName, fn: () => Promise<T>): Promise<T> {
    this.setActive(name, 1);
    const p = this.enqueue(fn);
    const done = () => this.setActive(name, -1);
    p.then(done, done);
    return p;
  }

  private setActive(name: CheckName, delta: 1 | -1): void {
    const before = this.status().running;
    const n = (this.active.get(name) ?? 0) + delta;
    if (n > 0) this.active.set(name, n);
    else this.active.delete(name);
    const running = this.status().running;
    if (running.join() !== before.join()) this.opts.bus.emit({ type: 'checks.status', running });
  }

  private report(what: string, e: unknown): void {
    if (this.disposed) return;
    console.error(`[checks] ${what}: ${errorMessage(e)}`);
  }

  private async runDeck(name: CheckName, scope?: Anchor): Promise<CheckRunResult> {
    const { store } = this.opts;
    const [brief, main] = await Promise.all([store.brief(), store.snapshot()]);
    const ids = scope ? slidesInRange(main.order, scope) : main.order;
    return this.execute({
      def: CHECKS[name],
      brief,
      snap: pick(main, ids),
      validIds: new Set(main.order),
      order: main.order,
      allowLanes: true,
      laneId: null,
      scopeIds: scope && scope.kind !== 'arc' ? new Set(ids) : null,
    });
  }

  /** Render check on the slides a lane changes, as they look with the lane's pending changes applied. */
  private async runLane(laneId: string): Promise<CheckRunResult> {
    const { store, bus } = this.opts;
    const lane = await store.lane(laneId);
    // Lanes proposed by the render check itself are not re-checked: their remarks would share an owner.
    if (!lane || lane.status !== 'open' || lane.origin === 'check:render') return { remarks: [], lanes: [] };
    const [brief, preview] = await Promise.all([store.brief(), new LaneService(store, bus).preview(laneId)]);
    if (preview.changed.length === 0) return { remarks: [], lanes: [] };
    return this.execute({
      def: render,
      brief,
      snap: pick(preview, preview.changed),
      validIds: new Set(preview.changed),
      order: preview.order,
      allowLanes: false,
      laneId,
      scopeIds: new Set(preview.changed),
    });
  }

  private async execute(t: Target): Promise<CheckRunResult> {
    const name = t.def.name;
    try {
      const outcome = await this.evaluate(t);
      if (this.disposed) throw new Error(STOPPED);
      return outcome.ok ? await this.persist(t, outcome.items) : await this.persistFailure(t, `${failurePrefix(name)}${outcome.reason}`);
    } finally {
      this.lastRun[name] = new Date().toISOString();
    }
  }

  /** One query, and one retry with a stricter instruction when the answer is unusable. */
  private async evaluate(t: Target): Promise<Outcome> {
    let thumbs: Record<SlideId, string> | undefined;
    if (t.def.needsThumbs) {
      try {
        thumbs = await this.thumbPaths(t.snap);
      } catch (e) {
        return { ok: false, reason: `could not render thumbnails: ${errorMessage(e)}` };
      }
    }
    const prompt = t.def.buildPrompt({ brief: t.brief, snap: t.snap, allowLanes: t.allowLanes, ...(thumbs ? { thumbs } : {}) });
    const first = await this.ask(t, prompt);
    // Disposed (the query was aborted): a retry would only start a query nobody waits for.
    if (first.ok || this.disposed) return first;
    const second = await this.ask(t, `${prompt}\n\nYour previous answer could not be used (${first.reason}). ${RETRY_INSTRUCTION}.`);
    return second.ok ? second : { ok: false, reason: second.reason };
  }

  private async thumbPaths(snap: Snapshot): Promise<Record<SlideId, string>> {
    const out: Record<SlideId, string> = {};
    for (const id of snap.order) out[id] = (await this.opts.thumbs.thumb(snap.slides[id]!)).path;
    return out;
  }

  private async ask(t: Target, prompt: string): Promise<Outcome> {
    let text: string;
    try {
      text = await this.complete(t.def, prompt);
    } catch (e) {
      return { ok: false, reason: errorMessage(e) };
    }
    return parseCheckOutput(text, t.validIds);
  }

  private async complete(def: CheckDef, prompt: string): Promise<string> {
    if (this.disposed) throw new Error(STOPPED);
    const { store, model } = this.opts;
    const abortController = new AbortController();
    this.current = abortController;
    const tools = def.needsThumbs ? ['Read'] : [];
    let text: string | null = null;
    let error: string | null = null;
    try {
      const q = this.queryImpl({
        prompt,
        options: {
          cwd: store.dir,
          model,
          systemPrompt: def.system,
          settingSources: [],
          tools,
          allowedTools: tools,
          permissionMode: 'dontAsk',
          maxTurns: def.needsThumbs ? THUMB_CHECK_MAX_TURNS : 1,
          abortController,
        },
      });
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type !== 'result') continue;
        if (m.subtype === 'success' && !m.is_error) text = m.result;
        else error = m.subtype === 'success' ? m.result : `${m.subtype}${m.errors.length ? `: ${m.errors.join('; ')}` : ''}`;
      }
    } catch (e) {
      // The SDK throws after yielding an error result; keep the result's own reason.
      if (error === null) error = abortController.signal.aborted ? 'interrupted' : errorMessage(e);
    } finally {
      if (this.current === abortController) this.current = null;
    }
    if (text !== null) return text;
    throw new Error(error ?? 'the query ended without a result');
  }

  /** Is `r` one of the remarks this run supersedes? */
  private async owned(t: Target, r: Remark, origin: Remark['origin']): Promise<boolean> {
    if (r.origin !== origin) return false;
    const source = r.sourceLaneId ?? null;
    // A lane run owns exactly the remarks found on that lane's preview, whatever lane answers them.
    if (t.laneId !== null) return source === t.laneId;
    // Remarks found on a lane's preview stay while that lane is open (closing it resolves them).
    if (source !== null) {
      const lane = await this.opts.store.lane(source);
      if (lane && lane.status === 'open') return false;
    }
    // A failure remark is always superseded by the check's next run on the same target.
    if (isFailureRemark(r, t.def.name)) return true;
    // A remark linked to a lane someone else opened (e.g. a lane the creator asked for from the remark's
    // thread) stays while that lane is open.
    if (r.laneId !== null) {
      const lane = await this.opts.store.lane(r.laneId);
      if (lane && lane.status === 'open' && lane.origin !== origin) return false;
    }
    if (t.scopeIds === null) return true;
    const ids = r.anchor.kind === 'range' ? slidesInRange([...t.order], r.anchor) : anchorIds(r.anchor);
    return ids.some((id) => t.scopeIds!.has(id));
  }

  private async persist(t: Target, items: Item[]): Promise<CheckRunResult> {
    const { store, bus } = this.opts;
    const origin = `check:${t.def.name}` as const;

    // Lanes first: propose_lane takes the deck lock itself.
    const lanes: Lane[] = [];
    const laneIds: (string | null)[] = [];
    for (const item of items) {
      laneIds.push(null);
      if (!item.lane || !t.allowLanes) continue;
      const res = await this.handlers.propose_lane(item.lane);
      if (!('laneId' in res) || typeof res.laneId !== 'string') {
        console.warn(`[checks] ${t.def.name}: proposed lane "${item.lane.label}" rejected: ${JSON.stringify(res)}`);
        continue;
      }
      const id = res.laneId;
      const lane = await store.withLock(async () => {
        const l = await store.lane(id);
        if (!l) return null;
        const next: Lane = { ...l, origin };
        await store.putLane(next);
        return next;
      });
      if (!lane) continue;
      bus.emit({ type: 'lane.updated', laneId: id });
      lanes.push(lane);
      laneIds[laneIds.length - 1] = id;
    }

    const now = new Date().toISOString();
    const remarks: Remark[] = items.map((item, k) => ({
      id: newId('r'),
      anchor: item.anchor,
      text: item.text,
      origin,
      severity: item.severity,
      status: 'open',
      laneId: laneIds[k] ?? null,
      ...(t.laneId !== null ? { sourceLaneId: t.laneId } : {}),
      createdAt: now,
    }));

    const closed = await store.withLock(async () => {
      const existing = await store.remarks();
      const kept: Remark[] = [];
      const replaced: Remark[] = [];
      for (const r of existing) ((await this.owned(t, r, origin)) ? replaced : kept).push(r);
      const closedIds: string[] = [];
      for (const r of replaced) {
        if (!r.laneId || closedIds.includes(r.laneId)) continue;
        const lane = await store.lane(r.laneId);
        // Only the check's own unsolicited lanes, and only while the creator has not acted on them.
        if (!lane || lane.origin !== origin || lane.status !== 'open' || !lane.changes.every((c) => c.status === 'pending')) continue;
        await store.putLane({ ...lane, status: 'closed' });
        closedIds.push(lane.id);
      }
      const next = [...kept, ...remarks];
      await store.putRemarks(resolveLaneRemarks(next, closedIds) ?? next);
      return closedIds;
    });

    for (const id of closed) bus.emit({ type: 'lane.closed', laneId: id });
    bus.emit({ type: 'remarks.changed' });
    return { remarks, lanes };
  }

  /** A failed run leaves the check's remarks and lanes as they were; only its failure remark is added or replaced. */
  private async persistFailure(t: Target, text: string): Promise<CheckRunResult> {
    const { store, bus } = this.opts;
    const origin = `check:${t.def.name}` as const;
    const source = t.laneId;
    const remark: Remark = {
      id: newId('r'),
      anchor: { kind: 'arc' },
      text,
      origin,
      severity: 'info',
      status: 'open',
      laneId: null,
      ...(source !== null ? { sourceLaneId: source } : {}),
      createdAt: new Date().toISOString(),
    };
    await store.withLock(async () => {
      const existing = await store.remarks();
      const kept = existing.filter((r) => !(r.origin === origin && (r.sourceLaneId ?? null) === source && isFailureRemark(r, t.def.name)));
      await store.putRemarks([...kept, remark]);
    });
    bus.emit({ type: 'remarks.changed' });
    return { remarks: [remark], lanes: [] };
  }
}
