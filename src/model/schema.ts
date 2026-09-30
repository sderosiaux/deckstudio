import { z } from 'zod';

export const SlideKindSchema = z.enum(['cover', 'diagram', 'code', 'text', 'close']);
export const SlideSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  story: z.string(),
  notes: z.string(),
  body: z.string(),
  assets: z.array(z.string()),
  kind: SlideKindSchema,
});
export const NewSlideSchema = SlideSchema.omit({ id: true });
export const SlidePatchSchema = SlideSchema.omit({ id: true }).partial();
export const BriefSchema = z.object({
  title: z.string(),
  audience: z.string(),
  message: z.string(),
  pattern: z.enum(['solution-first', 'problem-driven']),
  abstract: z.string(),
});
export const AnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slide'), slide: z.string().min(1) }),
  z.object({ kind: z.literal('range'), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ kind: z.literal('arc') }),
]);
export const ChangeStatusSchema = z.enum(['pending', 'accepted', 'refused', 'orphan']);
const changeBase = { id: z.string().min(1), reason: z.string(), status: ChangeStatusSchema };
export const ChangeSchema = z.discriminatedUnion('kind', [
  z.object({ ...changeBase, kind: z.literal('insert'), after: z.string().nullable(), slide: SlideSchema }),
  z.object({ ...changeBase, kind: z.literal('modify'), slide: z.string().min(1), patch: SlidePatchSchema }),
  z.object({ ...changeBase, kind: z.literal('remove'), slide: z.string().min(1) }),
  z.object({ ...changeBase, kind: z.literal('move'), slide: z.string().min(1), after: z.string().nullable() }),
]);
export const OriginSchema = z.union([z.literal('user'), z.templateLiteral(['check:', z.string().regex(/^[a-z]+$/)])]);
export const LaneSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  anchor: AnchorSchema,
  origin: OriginSchema,
  baseVersion: z.number().int().nonnegative(),
  changes: z.array(ChangeSchema),
  status: z.enum(['open', 'closed']),
  createdAt: z.string(),
});
export const RemarkSchema = z.object({
  id: z.string().min(1),
  anchor: AnchorSchema,
  text: z.string().min(1),
  origin: OriginSchema,
  severity: z.enum(['info', 'warn']),
  status: z.enum(['open', 'resolved']),
  laneId: z.string().nullable(),
  sourceLaneId: z.string().nullable().optional(),
  createdAt: z.string(),
});
export const VersionCauseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('import') }),
  z.object({ kind: z.literal('accept'), laneId: z.string(), changeId: z.string() }),
  z.object({ kind: z.literal('restore'), from: z.number().int(), entry: z.string() }),
]);
export const VersionSchema = z.object({
  n: z.number().int().nonnegative(),
  order: z.array(z.string()),
  slides: z.record(z.string(), z.string()),
  cause: VersionCauseSchema,
  createdAt: z.string(),
});
export const ThreadKeySchema = z.union([z.literal('global'), z.templateLiteral(['lane:', z.string().min(1)]), z.templateLiteral(['remark:', z.string().min(1)])]);
export const ThreadMessageSchema = z.object({
  id: z.string().min(1),
  thread: ThreadKeySchema,
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  context: AnchorSchema.nullable(),
  at: z.string(),
});
export const DeckStateSchema = z.object({
  name: z.string(),
  order: z.array(z.string()),
  version: z.number().int().nonnegative(),
  sessionId: z.string().nullable(),
  model: z.string(),
});

/** AI-facing inputs: a change before it gets an id and a status. */
export const NewChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('insert'), after: z.string().nullable(), slide: NewSlideSchema, reason: z.string().min(1) }),
  z.object({ kind: z.literal('modify'), slide: z.string().min(1), patch: SlidePatchSchema, reason: z.string().min(1) }),
  z.object({ kind: z.literal('remove'), slide: z.string().min(1), reason: z.string().min(1) }),
  z.object({ kind: z.literal('move'), slide: z.string().min(1), after: z.string().nullable(), reason: z.string().min(1) }),
]);
export const ProposeLaneInputSchema = z.object({
  label: z.string().min(1).max(80),
  anchor: AnchorSchema,
  changes: z.array(NewChangeSchema).min(1),
});
export const ReviseLaneInputSchema = z.object({ laneId: z.string().min(1), replaceChanges: z.array(NewChangeSchema).min(1) });
export const AddRemarkInputSchema = z.object({ anchor: AnchorSchema, text: z.string().min(1), severity: z.enum(['info', 'warn']) });

export type NewChange = z.infer<typeof NewChangeSchema>;
export type ProposeLaneInput = z.infer<typeof ProposeLaneInputSchema>;
export type ReviseLaneInput = z.infer<typeof ReviseLaneInputSchema>;
export type AddRemarkInput = z.infer<typeof AddRemarkInputSchema>;
