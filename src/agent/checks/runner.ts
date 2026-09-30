import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { newId } from '../../model/ids.js';
import { slidesInRange } from '../../model/ops.js';
import type { Anchor, Brief, Lane, Remark, SlideId, Snapshot } from '../../model/types.js';
import type { ThumbService } from '../../render/thumbs.js';
import type { Bus } from '../../server/bus.js';
import { LaneService } from '../../server/laneService.js';
import type { DeckStore } from '../../store/deckStore.js';
import { makeDeckToolHandlers, type DeckToolHandlers } from '../tools.js';
import { arc } from './arc.js';
import { gaps } from './gaps.js';
import { CHECK_NAMES, CheckResultSchema, isCheckName, type CheckDef, type CheckName, type CheckResult } from './index.js';
import { order } from './order.js';
import { render } from './render.js';

export { CheckResultSchema, type CheckDef, type CheckName } from './index.js';

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
  /** Set for a render check on a lane's preview: its remarks carry this laneId. */
  laneId: string | null;
  /** Null: the run covers the whole deck and replaces all of its check's remarks. */
  scopeIds: ReadonlySet<SlideId> | null;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
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
 * at most one check query is in flight per deck.
 */
export class CheckRunner {
  private readonly opts: CheckRunnerOptions;
  private readonly queryImpl: typeof query;
  private readonly handlers: DeckToolHandlers;
  private tail: Promise<unknown> = Promise.resolve();
  private running: CheckName[] = [];
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

  /** Runs one check now (after any queued run). `scope` restricts the slides shown and the remarks replaced. */
  run(name: CheckName, scope?: Anchor): Promise<CheckRunResult> {
    return this.enqueue(() => this.runDeck(name, scope));
  }

  /** Fire-and-forget start by name, for the run_check tool. Throws on an unknown name. */
  trigger(name: string): void {
    if (!isCheckName(name)) throw new Error(`unknown check "${name}"; available: ${CHECK_NAMES.join(', ')}`);
    this.run(name).catch((e) => this.report(name, e));
  }

  scheduleAfterAccept(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const name of CHECK_NAMES) this.run(name).catch((e) => this.report(name, e));
    }, this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  scheduleAfterLane(laneId: string): void {
    if (this.disposed) return;
    this.enqueue(() => this.runLane(laneId)).catch((e) => this.report(`render on lane ${laneId}`, e));
  }

  /** Stops pending schedules and aborts the query in flight. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current?.abort();
  }

  // -------------------------------------------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(() => {
      if (this.disposed) throw new Error('check runner stopped');
      return fn();
    });
    this.tail = p.catch(() => undefined);
    return p;
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

  private setRunning(next: CheckName[]): void {
    this.running = next;
    this.opts.bus.emit({ type: 'checks.status', running: [...next] });
  }

  private async execute(t: Target): Promise<CheckRunResult> {
    const name = t.def.name;
    this.setRunning([...this.running, name]);
    try {
      const outcome = await this.evaluate(t);
      const items: Item[] = outcome.ok
        ? outcome.items
        : [{ anchor: { kind: 'arc' }, severity: 'info', text: `check ${name} failed: ${outcome.reason}`, lane: null }];
      return await this.persist(t, items);
    } finally {
      const i = this.running.indexOf(name);
      this.setRunning(i < 0 ? this.running : [...this.running.slice(0, i), ...this.running.slice(i + 1)]);
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
    if (first.ok) return first;
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
    if (t.laneId !== null) return r.laneId === t.laneId;
    // A remark linked to a lane someone else opened (a lane-scoped render remark, or a lane the creator asked
    // for from the remark's thread) stays while that lane is open.
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
      laneIds.push(t.laneId);
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
      await store.putRemarks([...kept, ...remarks]);
      return closedIds;
    });

    for (const id of closed) bus.emit({ type: 'lane.closed', laneId: id });
    bus.emit({ type: 'remarks.changed' });
    return { remarks, lanes };
  }
}
