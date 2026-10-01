import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { BusEvent } from './bus.js';
import { deckOf } from './deckRequest.js';

const OPEN = 1;

/**
 * Registers GET /ws: each socket receives, as JSON, every event of the bus of the deck its URL addresses.
 * Each socket first gets `{ type: 'hello', version }`: events emitted while a client was disconnected are
 * lost, so a (re)connecting client resyncs from the deck version it is told.
 * Requires @fastify/websocket on an ancestor and deckPlugin's resolver hook.
 */
export function attachBus(app: FastifyInstance): void {
  const sockets = new Set<WebSocket>();
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const deck = deckOf(req);
    sockets.add(socket);
    const off = deck.bus.on('any', (event) => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(event));
    });
    const drop = (): void => {
      off();
      sockets.delete(socket);
    };
    socket.on('close', drop);
    socket.on('error', drop);
    try {
      const hello: BusEvent = { type: 'hello', version: (await deck.store.state()).version };
      if (socket.readyState === OPEN) socket.send(JSON.stringify(hello));
    } catch (err) {
      req.log.error({ err }, 'could not send hello on /ws');
    }
  });
  app.addHook('onClose', async () => {
    for (const s of sockets) s.terminate();
    sockets.clear();
  });
}
