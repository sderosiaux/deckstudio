import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Bus, BusEvent } from './bus.js';

const OPEN = 1;

/**
 * Registers GET /ws and forwards every bus event to every open socket as JSON.
 * Each socket first gets `{ type: 'hello', version }`: events emitted while a client was disconnected are
 * lost, so a (re)connecting client resyncs from the deck version it is told.
 * Requires @fastify/websocket to be registered on `app` first.
 */
export function attachBus(app: FastifyInstance, bus: Bus, deckVersion: () => Promise<number>): void {
  const sockets = new Set<WebSocket>();
  app.get('/ws', { websocket: true }, async (socket, req) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    try {
      const hello: BusEvent = { type: 'hello', version: await deckVersion() };
      if (socket.readyState === OPEN) socket.send(JSON.stringify(hello));
    } catch (err) {
      req.log.error({ err }, 'could not send hello on /ws');
    }
  });
  const off = bus.on('any', (event) => {
    const data = JSON.stringify(event);
    for (const s of sockets) if (s.readyState === OPEN) s.send(data);
  });
  app.addHook('onClose', async () => {
    off();
    for (const s of sockets) s.terminate();
    sockets.clear();
  });
}
