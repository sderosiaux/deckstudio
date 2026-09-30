import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Bus } from './bus.js';

const OPEN = 1;

/**
 * Registers GET /ws and forwards every bus event to every open socket as JSON.
 * Requires @fastify/websocket to be registered on `app` first.
 */
export function attachBus(app: FastifyInstance, bus: Bus): void {
  const sockets = new Set<WebSocket>();
  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
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
