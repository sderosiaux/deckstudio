import type { Anchor, Brief, DeckState, Lane, Slide, SlideId, ThreadKey, ThreadMessage, Version } from '../../src/model/types.js';
import type { BusEvent } from '../../src/server/bus.js';

export type { BusEvent };

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

/** The server answers errors as `{ error }`; surface that message rather than the bare status. */
async function failure(method: string, path: string, res: Response): Promise<Error> {
  let detail = res.statusText;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') detail = body.error;
  } catch {
    // body was not JSON: keep the status text
  }
  return new Error(`${method} ${path} failed: ${res.status} ${detail}`);
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw await failure('GET', path, res);
  return (await res.json()) as T;
}

async function send(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
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

/** Open lanes. */
export function getLanes(): Promise<Lane[]> {
  return getJson<Lane[]>('/api/lanes');
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

export const laneApi: LaneApi = { acceptChange, refuseChange, discardLane };
export const threadApi: ThreadApi = { getThread, postMessage };

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

/**
 * Listens to server events over /ws. Reconnects with exponential backoff (reset after a successful open)
 * until the returned function is called.
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
