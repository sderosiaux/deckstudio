import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentSession } from '../../agent/session.js';
import { AnchorSchema, ThreadKeySchema } from '../../model/schema.js';
import type { Anchor, ThreadKey } from '../../model/types.js';
import type { DeckStore } from '../../store/deckStore.js';

const SendBody = z.object({ text: z.string().trim().min(1), context: AnchorSchema.nullable().optional() });

type KeyParams = { key: string };

export function threadRoutes(app: FastifyInstance, store: DeckStore, session: AgentSession): void {
  const parseKey = (raw: string): ThreadKey | null => {
    const k = ThreadKeySchema.safeParse(raw);
    return k.success ? (k.data as ThreadKey) : null;
  };

  // A turn still running when the server stops is aborted, not left writing into a closed deck.
  app.addHook('onClose', async () => session.interrupt());

  // Registered before /:key so "interrupt" is never read as a thread key.
  app.post('/api/threads/interrupt', async () => {
    await session.interrupt();
    return { interrupted: true };
  });

  app.get<{ Params: KeyParams }>('/api/threads/:key', async (req, reply) => {
    const key = parseKey(req.params.key);
    if (!key) return reply.code(400).send({ error: `invalid thread key "${req.params.key}"` });
    return store.thread(key);
  });

  app.post<{ Params: KeyParams }>('/api/threads/:key/messages', async (req, reply) => {
    const key = parseKey(req.params.key);
    if (!key) return reply.code(400).send({ error: `invalid thread key "${req.params.key}"` });
    const body = SendBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    // A slide thread talks about one slide of main: a slide that is not there has nothing to talk about.
    if (key.startsWith('slide:')) {
      const slide = key.slice('slide:'.length);
      if (!(await store.state()).order.includes(slide)) return reply.code(404).send({ error: `slide "${slide}" is not on main` });
    }
    const context = (body.data.context ?? null) as Anchor | null;
    // The turn can take minutes; its progress reaches the client over the bus, not this response.
    session.send(key, body.data.text, context).catch((err: unknown) => req.log.error({ err, thread: key }, 'agent send failed'));
    return reply.code(202).send({ accepted: true });
  });
}
