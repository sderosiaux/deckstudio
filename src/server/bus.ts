import type { ThreadKey } from '../model/types.js';

export type BusEvent =
  | { type: 'deck.changed'; version: number }
  | { type: 'thumb.ready'; hash: string; slideId: string | null }
  | { type: 'lane.created'; laneId: string }
  | { type: 'lane.updated'; laneId: string }
  | { type: 'lane.closed'; laneId: string }
  | { type: 'remarks.changed' }
  | { type: 'checks.status'; running: string[] }
  | { type: 'assistant.delta'; thread: ThreadKey; text: string }
  | { type: 'assistant.done'; thread: ThreadKey; messageId: string }
  | { type: 'tool.call'; name: string; thread: ThreadKey }
  | { type: 'agent.error'; message: string; thread: ThreadKey };

type Handler = (e: BusEvent) => void;

/** In-process event bus. The WebSocket layer subscribes with `any` and forwards every event to clients. */
export class Bus {
  private handlers = new Map<string, Set<Handler>>();
  on(type: BusEvent['type'] | 'any', fn: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set<Handler>();
    set.add(fn);
    this.handlers.set(type, set);
    return () => set.delete(fn);
  }
  emit(e: BusEvent): void {
    for (const fn of this.handlers.get(e.type) ?? []) fn(e);
    for (const fn of this.handlers.get('any') ?? []) fn(e);
  }
}
