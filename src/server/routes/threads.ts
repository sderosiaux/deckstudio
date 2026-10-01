import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentSession } from '../../agent/session.js';
import { AnchorSchema, ThreadKeySchema } from '../../model/schema.js';
import type { Anchor, ThreadKey, ThreadMessage } from '../../model/types.js';
import type { DeckStore } from '../../store/deckStore.js';

const SendBody = z.object({ text: z.string().trim().min(1), context: AnchorSchema.nullable().optional() });

type KeyParams = { key: string };

/**
 * The turns of the global thread sent on exactly this slide: a user message with that context opens a turn, the
 * replies up to the next user message belong to it (the same rule the web applies to a range). Before slide threads
 * existed, a request on a selected slide was stored on the global thread; this keeps those turns in the slide panel.
 */
export function globalTurnsOn(global: readonly ThreadMessage[], slide: string): ThreadMessage[] {
  let inside = false;
  return global.filter((m) => {
    if (m.role === 'user') inside = m.context?.kind === 'slide' && m.context.slide === slide;
    return inside;
  });
}

/** Two time-ordered lists merged by `at`; on a tie the first list goes first. */
const mergeByTime = (a: readonly ThreadMessage[], b: readonly ThreadMessage[]): ThreadMessage[] => {
  const out: ThreadMessage[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i]!.at <= b[j]!.at)) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  return out;
};

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
    if (!key.startsWith('slide:')) return store.thread(key);
    const [own, global] = await Promise.all([store.thread(key), store.thread('global')]);
    return mergeByTime(globalTurnsOn(global, key.slice('slide:'.length)), own);
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
