export type SlideId = string;
export type SlideKind = 'cover' | 'diagram' | 'code' | 'text' | 'close';

export interface Slide {
  id: SlideId;
  title: string;
  story: string;
  notes: string;
  body: string;
  assets: string[];
  kind: SlideKind;
}

export type SlidePatch = Partial<Pick<Slide, 'title' | 'story' | 'notes' | 'body' | 'assets' | 'kind'>>;

export interface Brief {
  title: string;
  audience: string;
  message: string;
  pattern: 'solution-first' | 'problem-driven';
  abstract: string;
}

export interface DeckState {
  name: string;
  order: SlideId[];
  version: number;
  sessionId: string | null;
  model: string;
}

export type Anchor =
  | { kind: 'slide'; slide: SlideId }
  | { kind: 'range'; from: SlideId; to: SlideId }
  | { kind: 'arc' };

export type ChangeStatus = 'pending' | 'accepted' | 'refused' | 'orphan';

export type Change =
  | { id: string; kind: 'insert'; after: SlideId | null; slide: Slide; reason: string; status: ChangeStatus }
  | { id: string; kind: 'modify'; slide: SlideId; patch: SlidePatch; reason: string; status: ChangeStatus }
  | { id: string; kind: 'remove'; slide: SlideId; reason: string; status: ChangeStatus }
  | { id: string; kind: 'move'; slide: SlideId; after: SlideId | null; reason: string; status: ChangeStatus };

export type Origin = 'user' | `check:${string}`;

export interface Lane {
  id: string;
  label: string;
  anchor: Anchor;
  origin: Origin;
  baseVersion: number;
  changes: Change[];
  status: 'draft' | 'open' | 'closed';
  createdAt: string;
}

export interface Remark {
  id: string;
  anchor: Anchor;
  text: string;
  origin: Origin;
  severity: 'info' | 'warn';
  status: 'open' | 'resolved';
  /** Lane the creator asked to propose from this remark (link_remark_lane), if any. */
  laneId: string | null;
  /** Set when the remark was produced by a lane-scoped check run: it describes the lane's preview, not main. */
  sourceLaneId?: string | null;
  createdAt: string;
}

export type VersionCause =
  | { kind: 'import' }
  | { kind: 'accept'; laneId: string; changeId: string }
  | { kind: 'restore'; from: number; entry: string };

export interface Version {
  n: number;
  order: SlideId[];
  slides: Record<SlideId, string>;
  cause: VersionCause;
  createdAt: string;
}

export type ThreadKey = 'global' | `lane:${string}` | `remark:${string}` | `slide:${string}`;

export interface ThreadMessage {
  id: string;
  thread: ThreadKey;
  role: 'user' | 'assistant';
  text: string;
  context: Anchor | null;
  at: string;
}

export type DiffEntry =
  | { kind: 'added'; slide: SlideId; at: number }
  | { kind: 'removed'; slide: SlideId; wasAt: number }
  | { kind: 'modified'; slide: SlideId; fields: (keyof SlidePatch)[] }
  | { kind: 'moved'; slide: SlideId; from: number; to: number };

export interface Snapshot {
  order: SlideId[];
  slides: Record<SlideId, Slide>;
}
