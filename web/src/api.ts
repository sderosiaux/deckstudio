import type { Anchor, Brief, Change, DeckState, DiffEntry, Lane, Remark, Slide, SlideId, Snapshot, ThreadKey, ThreadMessage, Version } from '../../src/model/types.js';
import type { BusEvent as ServerBusEvent } from '../../src/server/bus.js';
import type { DesignInfo } from '../../src/server/routes/brief.js';
import type { CheckName, ChecksStatus } from '../../src/server/routes/checks.js';
import type { DeckSummary } from '../../src/server/registry.js';
import { withBase } from './base.js';

export type { CheckName, ChecksStatus, DeckSummary, DesignInfo };
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

/** Per-deck calls: the path is the deck's own ('/api/deck'), sent under the deck the page shows. */
const deckGet = <T>(path: string): Promise<T> => getJson<T>(withBase(path));
const deckSend = (method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Response> => send(method, withBase(path), body);

export function getDeck(): Promise<DeckPayload> {
  return deckGet<DeckPayload>('/api/deck');
}

export function getVersions(): Promise<Version[]> {
  return deckGet<Version[]>('/api/versions');
}

/** Asks the server for a slide's thumbnail; the server enqueues the render when it is not ready yet. */
export function thumbFor(slideId: SlideId): Promise<ThumbStatus> {
  return deckGet<ThumbStatus>(`/api/thumbs/for/${encodeURIComponent(slideId)}`);
}

/** A slide as it was in version n (history): same hash cache as main's thumbs; `thumb.ready` follows, matched by hash. */
export function thumbForVersion(n: number, slideId: SlideId): Promise<ThumbStatus> {
  return deckGet<ThumbStatus>(`/api/thumbs/version/${n}/${encodeURIComponent(slideId)}`);
}

export function thumbUrl(hash: string): string {
  return withBase(`/api/thumbs/${hash}.png`);
}

export type LaneFilter = 'draft' | 'open' | 'all';

/**
 * A change as GET /api/lanes and /api/lanes/:id send it: a pending modify also lists `variantOf`, the ids of the other
 * open lanes with a pending modify on the same slide and field. Computed by the server at read time, never stored.
 */
export type LaneChange = Change & { variantOf?: string[] };
export type LanePayload = Omit<Lane, 'changes'> & { changes: LaneChange[] };

/** Open lanes by default; `draft` lists the lanes a check proposed that the creator has not opened yet, `all` includes closed ones. */
export function getLanes(status?: LaneFilter): Promise<LanePayload[]> {
  return deckGet<LanePayload[]>(status ? `/api/lanes?status=${status}` : '/api/lanes');
}

/** Turns a draft lane into an open one; `lane.updated` follows. */
export async function openLane(laneId: string): Promise<void> {
  await deckSend('POST', `/api/lanes/${seg(laneId)}/open`);
}

/** One lane by id, open or closed. */
export function getLane(laneId: string): Promise<LanePayload> {
  return deckGet<LanePayload>(`/api/lanes/${seg(laneId)}`);
}

/** Also enqueues the thumbnails of the lane's changed slides; `thumb.ready` follows for each. */
export function getLanePreview(laneId: string): Promise<LanePreviewPayload> {
  return deckGet<LanePreviewPayload>(`/api/lanes/${seg(laneId)}/preview`);
}

export async function acceptChange(laneId: string, changeId: string): Promise<{ version: Version; lane: Lane }> {
  const res = await deckSend('POST', `/api/lanes/${seg(laneId)}/changes/${seg(changeId)}/accept`);
  return (await res.json()) as { version: Version; lane: Lane };
}

export async function refuseChange(laneId: string, changeId: string): Promise<Lane> {
  const res = await deckSend('POST', `/api/lanes/${seg(laneId)}/changes/${seg(changeId)}/refuse`);
  return (await res.json()) as Lane;
}

export async function discardLane(laneId: string): Promise<void> {
  await deckSend('DELETE', `/api/lanes/${seg(laneId)}`);
}

export function getThread(key: ThreadKey): Promise<ThreadMessage[]> {
  return deckGet<ThreadMessage[]>(`/api/threads/${seg(key)}`);
}

/** The server answers 202 and streams the reply as `assistant.delta` events, then `assistant.done`. */
export async function postMessage(key: ThreadKey, text: string, context: Anchor | null): Promise<void> {
  await deckSend('POST', `/api/threads/${seg(key)}/messages`, { text, context });
}

export function getBrief(): Promise<Brief> {
  return deckGet<Brief>('/api/brief');
}

export function getDesign(): Promise<DesignInfo> {
  return deckGet<DesignInfo>('/api/brief/design');
}

export async function putBrief(brief: Brief): Promise<Brief> {
  const res = await deckSend('PUT', '/api/brief', brief);
  return (await res.json()) as Brief;
}

/** Every remark, open ones first. */
export function getRemarks(): Promise<Remark[]> {
  return deckGet<Remark[]>('/api/remarks');
}

export interface NewRemark {
  anchor: Anchor;
  text: string;
  severity: Remark['severity'];
}

export async function postRemark(input: NewRemark): Promise<Remark> {
  const res = await deckSend('POST', '/api/remarks', input);
  return (await res.json()) as Remark;
}

export async function resolveRemark(id: string): Promise<Remark> {
  const res = await deckSend('POST', `/api/remarks/${seg(id)}/resolve`);
  return (await res.json()) as Remark;
}

/** Hands the remark to the co-author on thread `remark:<id>`; the lane it proposes arrives as `lane.created`. */
export async function proposeRemark(id: string): Promise<void> {
  await deckSend('POST', `/api/remarks/${seg(id)}/propose`);
}

/** Starts the checks in the background (all four when `names` is omitted); progress arrives as `checks.status`. */
export async function runChecks(names?: CheckName[]): Promise<{ started: CheckName[] }> {
  const res = await deckSend('POST', '/api/checks/run', names ? { names } : {});
  return (await res.json()) as { started: CheckName[] };
}

export function getChecksStatus(): Promise<ChecksStatus> {
  return deckGet<ChecksStatus>('/api/checks/status');
}

/** What `GET /api/history/diff` answers: the entries that turn version `a` into version `b`. */
export interface HistoryDiff {
  a: number;
  b: number;
  entries: DiffEntry[];
}

/** Main as it was at version `n`. */
export function getVersionSnapshot(n: number): Promise<Snapshot> {
  return deckGet<Snapshot>(`/api/versions/${n}`);
}

export function getHistoryDiff(a: number, b: number): Promise<HistoryDiff> {
  return deckGet<HistoryDiff>(`/api/history/diff?a=${a}&b=${b}`);
}

/** Undoes one entry of the diff from version `from` onto current main; the server records a `restore` version. */
export async function restoreEntry(from: number, entry: DiffEntry): Promise<void> {
  await deckSend('POST', '/api/history/restore', { from, entry });
}

/** Proposes, as a user lane, the changes that bring current main back to version `n`. */
export async function openVersionAsLane(n: number): Promise<{ laneId: string }> {
  const res = await deckSend('POST', '/api/history/open-as-lane', { n });
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

/** What a thread needs to show, under a reply, the lane that reply proposed and to decide its changes in place. */
export interface ProposalApi {
  getLane(laneId: string): Promise<Lane>;
  getLanePreview(laneId: string): Promise<LanePreviewPayload>;
  thumbFor(slideId: SlideId): Promise<ThumbStatus>;
  acceptChange(laneId: string, changeId: string): Promise<{ version: Version; lane: Lane }>;
  refuseChange(laneId: string, changeId: string): Promise<Lane>;
}

/** True when `api` can also show a reply's proposal (every method of ProposalApi is there). */
export function hasProposals(api: ThreadApi & Partial<ProposalApi>): api is ThreadApi & ProposalApi {
  return !!(api.getLane && api.getLanePreview && api.thumbFor && api.acceptChange && api.refuseChange);
}

/** Everything the focus screen reads and writes, injectable for tests. */
export interface FocusApi extends ThreadApi, ProposalApi {
  getDeck(): Promise<DeckPayload>;
}

/** Everything the slide edit screen reads and writes, injectable for tests. */
export interface SlideApi extends ThreadApi, ProposalApi {
  getDeck(): Promise<DeckPayload>;
  getLanes(status?: LaneFilter): Promise<Lane[]>;
  discardLane(laneId: string): Promise<void>;
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
  getDesign(): Promise<DesignInfo>;
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
  thumbForVersion(n: number, slideId: SlideId): Promise<ThumbStatus>;
}

export const laneApi: LaneApi = { acceptChange, refuseChange, discardLane };
export const threadApi: ThreadApi & ProposalApi = { getThread, postMessage, getLane, getLanePreview, thumbFor, acceptChange, refuseChange };
export const focusApi: FocusApi = { getDeck, getLane, getLanePreview, thumbFor, acceptChange, refuseChange, getThread, postMessage };
export const slideApi: SlideApi = { getDeck, getLanes, getLane, getLanePreview, thumbFor, acceptChange, refuseChange, discardLane, getThread, postMessage };
export const remarkApi: RemarkApi = { proposeRemark, resolveRemark };
export const briefChecksApi: BriefChecksApi = { getDeck, getBrief, putBrief, getRemarks, proposeRemark, runChecks, getChecksStatus, getLanes, openLane, thumbFor, getDesign };
export const historyApi: HistoryApi = { getDeck, getVersions, getVersionSnapshot, getHistoryDiff, restoreEntry, openVersionAsLane, thumbFor, thumbForVersion };

/**
 * Client-side routes, full paths under the deck the page shows (/d/<id>/...): hrefs and navigate() take them as they
 * are. The server answers index.html for any non-API path, so these also work on reload.
 */
export function focusPath(laneId: string, changeId: string): string {
  return withBase(`/lane/${seg(laneId)}/change/${seg(changeId)}`);
}

/** One slide of main on its edit screen, with the co-author thread `slide:<id>`. */
export function slidePath(slideId: SlideId): string {
  return withBase(`/slide/${seg(slideId)}`);
}

/** Main with a slide (or range) selected: `?select=<slideId>` and, for a range, `&to=<slideId>`. Arc selects nothing. */
export function mainPath(anchor: Anchor): string {
  if (anchor.kind === 'slide') return withBase(`/?select=${seg(anchor.slide)}`);
  if (anchor.kind === 'range') return withBase(`/?select=${seg(anchor.from)}&to=${seg(anchor.to)}`);
  return mainHref();
}

/** Main of the deck the page shows, nothing selected. */
export function mainHref(): string {
  return withBase('/');
}

/** Reads what `mainPath` wrote. */
export function selectionFromSearch(search: string): Anchor | null {
  const q = new URLSearchParams(search);
  const from = q.get('select');
  if (!from) return null;
  const to = q.get('to');
  return to && to !== from ? { kind: 'range', from, to } : { kind: 'slide', slide: from };
}

/** Screen routes inside a deck, as App matches them once the deck base is stripped. */
export const BRIEF_ROUTE = '/brief';
export const HISTORY_ROUTE = '/history';
export const PRESENT_ROUTE = '/present';

export function briefPath(): string {
  return withBase(BRIEF_ROUTE);
}

/** The history screen; with a pair, comparing v<a> with v<b> (the screen reads `?a=&b=` on mount). */
export function historyPath(a?: number, b?: number): string {
  return a === undefined || b === undefined ? withBase(HISTORY_ROUTE) : withBase(`${HISTORY_ROUTE}?a=${a}&b=${b}`);
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
  return withBase(`/#lane=${seg(laneId)}`);
}

/** Reads what `laneOnMainPath` wrote. */
export function laneFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('lane') || null;
}

/** Hands the tab to the standalone player (a full page load, so the browser's back button returns here). */
export function openPlayer(href: string): void {
  location.assign(href);
}

/** The player URL, opened on slide `index` (0-based) when known. */
export function playerHref(index: number): string {
  return index >= 0 ? `${presentUrl()}#${index + 1}` : presentUrl();
}

/** The standalone player page of the deck the page shows. */
export function presentUrl(): string {
  return withBase('/api/present');
}

/** Changes the screen without a page load; App listens to popstate. `path` is a full path (see the route helpers). */
export function navigate(path: string): void {
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

/** The home screen: every deck of the studio. */
export const HOME_PATH = '/';

/** Main of deck `id`, from anywhere (the home screen has no deck base). */
export function deckHref(id: string): string {
  return `/d/${seg(id)}/`;
}

/** Every deck of the studio, most recently changed first. Root route: the same from the home screen or a deck. */
export function listDecks(): Promise<DeckSummary[]> {
  return getJson<DeckSummary[]>('/api/decks');
}

/** One deck's summary; ApiError 404 when the studio has no deck by that id. */
export function getDeckSummary(id: string): Promise<DeckSummary> {
  return getJson<DeckSummary>(`/api/decks/${seg(id)}`);
}

export interface NewDeck {
  title: string;
  audience: string;
  message: string;
  pattern?: Brief['pattern'];
  abstract?: string;
  /** Left out, the server writes the starter rules. */
  design?: { rules?: string };
}

/** Creates an empty deck with the starter brief; ApiError 409 when its id (the title's slug) is taken. */
export async function createDeck(input: NewDeck): Promise<DeckSummary> {
  const res = await send('POST', '/api/decks', input);
  return (await res.json()) as DeckSummary;
}

/** Imports a single-file deck.html from a path on the server's machine. */
export async function importDeck(path: string): Promise<DeckSummary> {
  const res = await send('POST', '/api/decks/import', { path });
  return (await res.json()) as DeckSummary;
}

/** A slide's thumbnail in deck `id` (the home screen's cover), enqueued by the server when not ready yet. */
export function deckThumbFor(id: string, slideId: SlideId): Promise<ThumbStatus> {
  return getJson<ThumbStatus>(`/d/${seg(id)}/api/thumbs/for/${seg(slideId)}`);
}

export function deckThumbUrl(id: string, hash: string): string {
  return `/d/${seg(id)}/api/thumbs/${hash}.png`;
}

/** What the home screen reads and writes, injectable for tests. */
export interface HomeApi {
  listDecks(): Promise<DeckSummary[]>;
  createDeck(input: NewDeck): Promise<DeckSummary>;
  importDeck(path: string): Promise<DeckSummary>;
  deckThumbFor(id: string, slideId: SlideId): Promise<ThumbStatus>;
}
export const homeApi: HomeApi = { listDecks, createDeck, importDeck, deckThumbFor };

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
    const ws = new WebSocket(`${proto}://${location.host}${withBase('/ws')}`);
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
