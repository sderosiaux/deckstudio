import type { Brief, DeckState, Slide, SlideId, Version } from '../../src/model/types.js';
import type { BusEvent } from '../../src/server/bus.js';

export type { BusEvent };

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

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

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
