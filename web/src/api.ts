import type { Anchor, Brief, DeckState, DiffEntry, Lane, Remark, Slide, SlideId, Snapshot, ThreadKey, ThreadMessage, Version } from '../../src/model/types.js';
import type { BusEvent as ServerBusEvent } from '../../src/server/bus.js';
import type { CheckName, ChecksStatus } from '../../src/server/routes/checks.js';

export type { CheckName, ChecksStatus };
/**
 * `hello` arrives on every (re)open of the socket. `subscribe` emits it itself with `version: null`
 * (the client cannot know the server's version); the server may also send its own with the deck version.
 * Either way, events sent while the socket was down are lost, so a hello means "resync".
 */
export type HelloEvent = { type: 'hello'; version: number | null };
export type BusEvent = ServerBusEvent | HelloEvent;

export type LaneEvent = Extract<BusEvent, { type: 'lane.created' | 'lane.updated' | 'lane.closed' }>;
export type AssistantEvent = Extract<BusEvent, { type: 'assistant.delta' | 'assistant.done' | 'tool.call' | 'agent.error' }>;
export type DeckChangedEvent = Extract<BusEvent, { type: 'deck.changed' }>;

export const isLaneEvent = (e: BusEvent): e is LaneEvent => e.type === 'lane.created' || e.type === 'lane.updated' || e.type === 'lane.closed';
export const isAssistantEvent = (e: BusEvent): e is AssistantEvent =>
  e.type === 'assistant.delta' || e.type === 'assistant.done' || e.type === 'tool.call' || e.type === 'agent.error';
export const isDeckChanged = (e: BusEvent): e is DeckChangedEvent => e.type === 'deck.changed';

export interface DeckPayload {
  state: DeckState;
  brief: Brief;
  order: SlideId[];
  slides: Record<SlideId, Slide>;
}

export interface ThumbStatus {
  hash: string;
  ready: boolean;
}

/** Lane preview: main with all pending changes of the lane applied, plus the render status of every changed slide. */
export interface LanePreviewPayload {
  order: SlideId[];
  slides: Record<SlideId, Slide>;
  /** Pending change ids that no longer apply on current main. */
  skipped: string[];
  thumbs: Record<SlideId, ThumbStatus>;
}

/** A non-2xx answer. `status` and the server's own `detail` let a screen word the error for a person. */
export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${method} ${path} failed: ${status} ${detail}`);
    this.name = 'ApiError';
  }
}

/** The server answers errors as `{ error }`; surface that message rather than the bare status. */
async function failure(method: string, path: string, res: Response): Promise<Error> {
  let detail = res.statusText;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') detail = body.error;
  } catch {
    // body was not JSON: keep the status text
  }
  return new ApiError(method, path, res.status, detail);
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw await failure('GET', path, res);
  return (await res.json()) as T;
}

async function send(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers = { accept: 'application/json', 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) throw await failure(method, path, res);
  return res;
}

const seg = encodeURIComponent;

export function getDeck(): Promise<DeckPayload> {
  return getJson<DeckPayload>('/api/deck');
}

export function getVersions(): Promise<Version[]> {
  return getJson<Version[]>('/api/versions');
}

/** Asks the server for a slide's thumbnail; the server enqueues the render when it is not ready yet. */
export function thumbFor(slideId: SlideId): Promise<ThumbStatus> {
  return getJson<ThumbStatus>(`/api/thumbs/for/${encodeURIComponent(slideId)}`);
}

export function thumbUrl(hash: string): string {
  return `/api/thumbs/${hash}.png`;
}

export type LaneFilter = 'draft' | 'open' | 'all';

/** Open lanes by default; `draft` lists the lanes a check proposed that the creator has not opened yet, `all` includes closed ones. */
export function getLanes(status?: LaneFilter): Promise<Lane[]> {
  return getJson<Lane[]>(status ? `/api/lanes?status=${status}` : '/api/lanes');
}

/** Turns a draft lane into an open one; `lane.updated` follows. */
export async function openLane(laneId: string): Promise<void> {
  await send('POST', `/api/lanes/${seg(laneId)}/open`);
}

/** One lane by id, open or closed. */
export function getLane(laneId: string): Promise<Lane> {
  return getJson<Lane>(`/api/lanes/${seg(laneId)}`);
}

/** Also enqueues the thumbnails of the lane's changed slides; `thumb.ready` follows for each. */
export function getLanePreview(laneId: string): Promise<LanePreviewPayload> {
  return getJson<LanePreviewPayload>(`/api/lanes/${seg(laneId)}/preview`);
}

export async function acceptChange(laneId: string, changeId: string): Promise<{ version: Version; lane: Lane }> {
  const res = await send('POST', `/api/lanes/${seg(laneId)}/changes/${seg(changeId)}/accept`);
  return (await res.json()) as { version: Version; lane: Lane };
}

export async function refuseChange(laneId: string, changeId: string): Promise<Lane> {
  const res = await send('POST', `/api/lanes/${seg(laneId)}/changes/${seg(changeId)}/refuse`);
  return (await res.json()) as Lane;
}

export async function discardLane(laneId: string): Promise<void> {
  await send('DELETE', `/api/lanes/${seg(laneId)}`);
}

export function getThread(key: ThreadKey): Promise<ThreadMessage[]> {
  return getJson<ThreadMessage[]>(`/api/threads/${seg(key)}`);
}

/** The server answers 202 and streams the reply as `assistant.delta` events, then `assistant.done`. */
export async function postMessage(key: ThreadKey, text: string, context: Anchor | null): Promise<void> {
  await send('POST', `/api/threads/${seg(key)}/messages`, { text, context });
}

export function getBrief(): Promise<Brief> {
  return getJson<Brief>('/api/brief');
}

export async function putBrief(brief: Brief): Promise<Brief> {
  const res = await send('PUT', '/api/brief', brief);
  return (await res.json()) as Brief;
}

/** Every remark, open ones first. */
export function getRemarks(): Promise<Remark[]> {
  return getJson<Remark[]>('/api/remarks');
}

export interface NewRemark {
  anchor: Anchor;
  text: string;
  severity: Remark['severity'];
}

export async function postRemark(input: NewRemark): Promise<Remark> {
  const res = await send('POST', '/api/remarks', input);
  return (await res.json()) as Remark;
}

export async function resolveRemark(id: string): Promise<Remark> {
  const res = await send('POST', `/api/remarks/${seg(id)}/resolve`);
  return (await res.json()) as Remark;
}

/** Hands the remark to the co-author on thread `remark:<id>`; the lane it proposes arrives as `lane.created`. */
export async function proposeRemark(id: string): Promise<void> {
  await send('POST', `/api/remarks/${seg(id)}/propose`);
}

/** Starts the checks in the background (all four when `names` is omitted); progress arrives as `checks.status`. */
export async function runChecks(names?: CheckName[]): Promise<{ started: CheckName[] }> {
  const res = await send('POST', '/api/checks/run', names ? { names } : {});
  return (await res.json()) as { started: CheckName[] };
}

export function getChecksStatus(): Promise<ChecksStatus> {
  return getJson<ChecksStatus>('/api/checks/status');
}

/** What `GET /api/history/diff` answers: the entries that turn version `a` into version `b`. */
export interface HistoryDiff {
  a: number;
  b: number;
  entries: DiffEntry[];
}

/** Main as it was at version `n`. */
export function getVersionSnapshot(n: number): Promise<Snapshot> {
  return getJson<Snapshot>(`/api/versions/${n}`);
}

export function getHistoryDiff(a: number, b: number): Promise<HistoryDiff> {
  return getJson<HistoryDiff>(`/api/history/diff?a=${a}&b=${b}`);
}

/** Undoes one entry of the diff from version `from` onto current main; the server records a `restore` version. */
export async function restoreEntry(from: number, entry: DiffEntry): Promise<void> {
  await send('POST', '/api/history/restore', { from, entry });
}

/** Proposes, as a user lane, the changes that bring current main back to version `n`. */
export async function openVersionAsLane(n: number): Promise<{ laneId: string }> {
  const res = await send('POST', '/api/history/open-as-lane', { n });
  return (await res.json()) as { laneId: string };
}

/** The lane-related calls, grouped so components can take them as an injectable dependency. */
export interface LaneApi {
  acceptChange(laneId: string, changeId: string): Promise<unknown>;
  refuseChange(laneId: string, changeId: string): Promise<unknown>;
  discardLane(laneId: string): Promise<void>;
}

export interface ThreadApi {
  getThread(key: ThreadKey): Promise<ThreadMessage[]>;
  postMessage(key: ThreadKey, text: string, context: Anchor | null): Promise<void>;
}

/** Everything the focus screen reads and writes, injectable for tests. */
export interface FocusApi extends ThreadApi {
  getDeck(): Promise<DeckPayload>;
  getLane(laneId: string): Promise<Lane>;
  getLanePreview(laneId: string): Promise<LanePreviewPayload>;
  thumbFor(slideId: SlideId): Promise<ThumbStatus>;
  acceptChange(laneId: string, changeId: string): Promise<{ version: Version; lane: Lane }>;
  refuseChange(laneId: string, changeId: string): Promise<Lane>;
}

/** Remark actions available from a post-it on main. */
export interface RemarkApi {
  proposeRemark(id: string): Promise<void>;
  resolveRemark(id: string): Promise<unknown>;
}

/** Everything the brief & checks screen reads and writes, injectable for tests. */
export interface BriefChecksApi {
  getDeck(): Promise<DeckPayload>;
  getBrief(): Promise<Brief>;
  putBrief(brief: Brief): Promise<Brief>;
  getRemarks(): Promise<Remark[]>;
  proposeRemark(id: string): Promise<void>;
  runChecks(names?: CheckName[]): Promise<{ started: CheckName[] }>;
  getChecksStatus(): Promise<ChecksStatus>;
  getLanes(status?: LaneFilter): Promise<Lane[]>;
  openLane(laneId: string): Promise<void>;
  thumbFor(slideId: SlideId): Promise<ThumbStatus>;
}

/** Everything the history screen reads and writes, injectable for tests. */
export interface HistoryApi {
  getDeck(): Promise<DeckPayload>;
  getVersions(): Promise<Version[]>;
  getVersionSnapshot(n: number): Promise<Snapshot>;
  getHistoryDiff(a: number, b: number): Promise<HistoryDiff>;
  restoreEntry(from: number, entry: DiffEntry): Promise<void>;
  openVersionAsLane(n: number): Promise<{ laneId: string }>;
  thumbFor(slideId: SlideId): Promise<ThumbStatus>;
}

export const laneApi: LaneApi = { acceptChange, refuseChange, discardLane };
export const threadApi: ThreadApi = { getThread, postMessage };
export const focusApi: FocusApi = { getDeck, getLane, getLanePreview, thumbFor, acceptChange, refuseChange, getThread, postMessage };
export const remarkApi: RemarkApi = { proposeRemark, resolveRemark };
export const briefChecksApi: BriefChecksApi = { getDeck, getBrief, putBrief, getRemarks, proposeRemark, runChecks, getChecksStatus, getLanes, openLane, thumbFor };
export const historyApi: HistoryApi = { getDeck, getVersions, getVersionSnapshot, getHistoryDiff, restoreEntry, openVersionAsLane, thumbFor };

/** Client-side routes. The server answers index.html for any non-API path, so these also work on reload. */
export function focusPath(laneId: string, changeId: string): string {
  return `/lane/${seg(laneId)}/change/${seg(changeId)}`;
}

/** Main with a slide (or range) selected: `?select=<slideId>` and, for a range, `&to=<slideId>`. Arc selects nothing. */
export function mainPath(anchor: Anchor): string {
  if (anchor.kind === 'slide') return `/?select=${seg(anchor.slide)}`;
  if (anchor.kind === 'range') return `/?select=${seg(anchor.from)}&to=${seg(anchor.to)}`;
  return '/';
}

/** Reads what `mainPath` wrote. */
export function selectionFromSearch(search: string): Anchor | null {
  const q = new URLSearchParams(search);
  const from = q.get('select');
  if (!from) return null;
  const to = q.get('to');
  return to && to !== from ? { kind: 'range', from, to } : { kind: 'slide', slide: from };
}

export const BRIEF_PATH = '/brief';
export const HISTORY_PATH = '/history';

/** History comparing v<a> with v<b>; the history screen reads `?a=&b=` on mount. */
export function historyPath(a: number, b: number): string {
  return `${HISTORY_PATH}?a=${a}&b=${b}`;
}

/** Reads what `historyPath` wrote; null unless both are version numbers. */
export function pairFromSearch(search: string): { a: number; b: number } | null {
  const q = new URLSearchParams(search);
  const a = q.get('a');
  const b = q.get('b');
  if (a === null || b === null || !/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
  return { a: Number(a), b: Number(b) };
}

/** Main scrolled to one lane: `/#lane=<laneId>`. A hash, so main's `?select=` cleanup does not race it. */
export function laneOnMainPath(laneId: string): string {
  return `/#lane=${seg(laneId)}`;
}

/** Reads what `laneOnMainPath` wrote. */
export function laneFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('lane') || null;
}

/** Changes the screen without a page load; App listens to popstate. */
export function navigate(path: string): void {
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

/**
 * Listens to server events over /ws. Reconnects with exponential backoff (reset after a successful open)
 * until the returned function is called. Every open, first or not, delivers `{ type: 'hello', version: null }`.
 */
export function subscribe(handler: (e: BusEvent) => void): () => void {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = BACKOFF_MIN_MS;
  let closed = false;

  const connect = (): void => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    socket = ws;
    ws.onopen = () => {
      delay = BACKOFF_MIN_MS;
      if (!closed && socket === ws) handler({ type: 'hello', version: null });
    };
    ws.onmessage = (msg: MessageEvent) => {
      if (typeof msg.data !== 'string') return;
      let evt: unknown;
      try {
        evt = JSON.parse(msg.data);
      } catch {
        console.warn('deckstudio: ignoring non-JSON ws message');
        return;
      }
      if (evt && typeof evt === 'object' && typeof (evt as { type?: unknown }).type === 'string') handler(evt as BusEvent);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (closed) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    };
    // An error is always followed by close, which schedules the retry.
    ws.onerror = () => undefined;
  };

  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    socket?.close();
    socket = null;
  };
}
