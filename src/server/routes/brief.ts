import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DIAGRAM_STYLE } from '../../agent/imageGen.js';
import { BriefSchema } from '../../model/schema.js';
import { deckOf } from '../deckRequest.js';

/** What the brief screen shows around the design rules: the built-in image style and the deck's theme.css. */
export interface DesignInfo {
  /** Applied to generated images when the brief's imageStyle is empty. */
  defaultImageStyle: string;
  themeCssPath: string;
  /** False: the deck has no theme.css and the built-in theme applies. */
  themeCssPresent: boolean;
}

export function briefRoutes(app: FastifyInstance): void {
  app.get('/api/brief', async (req) => deckOf(req).store.brief());

  app.put('/api/brief', async (req, reply) => {
    const parsed = BriefSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `invalid brief: ${parsed.error.message}` });
    await deckOf(req).store.setBrief(parsed.data);
    return parsed.data;
  });

  app.get('/api/brief/design', async (req): Promise<DesignInfo> => {
    const themeCssPath = join(deckOf(req).store.dir, 'theme.css');
    const themeCssPresent = await access(themeCssPath).then(() => true, () => false);
    return { defaultImageStyle: DIAGRAM_STYLE, themeCssPath, themeCssPresent };
  });
}
