# Deckstudio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app where a deck is the source of truth, the AI co-author proposes lanes of typed changes anchored to a slide range, the creator accepts or refuses change by change, and background checks produce anchored remarks.

**Architecture:** One TypeScript package. `src/model` holds pure, immutable domain logic (types, zod schemas, apply/rebase/diff). `src/store` persists a deck folder on disk (content-addressed slide objects, version manifests). `src/render` assembles a slide into the fixed 1280x720 stage and screenshots it with Playwright. `src/agent` wraps the Claude Agent SDK: one persistent session per deck, an in-process MCP server exposing typed deck tools, a permission hook that blocks writes to the deck folder, and checks run as fresh `query()` calls with zod-validated JSON output. `src/server` is Fastify (REST + WebSocket) serving `web/` (Vite React). `src/cli` starts the server on a deck folder.

**Tech Stack:** Node 22, TypeScript 5 (ESM), pnpm, zod 4, fastify 5 (+ @fastify/websocket, @fastify/static), @anthropic-ai/claude-agent-sdk 0.3.x, playwright 1.63, vitest 4, vite 8, react 19, nanoid.

**Spec:** `docs/superpowers/specs/2026-09-30-deckstudio-design.md`

## Global Constraints

- Light theme only. Stage is 1280x720; grid x 96..1184; title rendered by the theme at 82px; body is an HTML fragment.
- The AI never writes deck files except under `assets/`. Enforced by a permission hook, tested.
- No `<ul>`/`<ol>` in a slide body produced by the AI (render check flags it; tool input rejects it).
- Storage is plain files in the deck folder; no database, no git under the hood.
- Default model `claude-opus-5` for session and checks, per-deck override in `deck.json`.
- Tests: vitest; no fixed sleeps, poll with `waitFor(cond, {timeout, interval})`.
- Commits: one per milestone, under the global git identity, no Co-Authored-By.
- Every task keeps `pnpm typecheck && pnpm test` green.

## Review Focus

1. Accepting a change in lane A after lane B was also anchored on the same slides: B's changes referencing a slide removed by A must become `orphan`, not crash. Test in Task 2 (`rebaseLane` orphan case).
2. An `insert` whose `after` slide was itself moved by an earlier accepted change: the insert must follow the slide's new position (anchors are by id, not index). Test in Task 2.
3. A slide body with an unbalanced tag or a `<script>`: renderer must not execute scripts and must not break the stage. Test in Task 5 (script stripped, stage still 1280x720).
4. The AI returns a lane whose `changes` reference a slide id that does not exist: tool validation must reject it with a message the model can act on, not persist garbage. Test in Task 8.
5. Two accepts in quick succession from the UI: versions must be strictly sequential and the second accept must apply on top of the first (server serializes deck mutations per deck). Test in Task 9.

---

## File structure

```
package.json, pnpm-lock.yaml, tsconfig.json, vitest.config.ts, vite.config.ts
bin/deckstudio.js                      CLI entry (tsx-free: runs built dist)
src/model/types.ts                     domain types
src/model/schema.ts                    zod schemas mirroring types (+ AI tool inputs)
src/model/ids.ts                       id + content hash helpers
src/model/ops.ts                       applyChange, rebaseLane, diffVersions, validateBody
src/store/deckStore.ts                 read/write a deck folder; objects; versions; lanes; remarks; threads; brief
src/store/locks.ts                     per-deck async mutex
src/render/theme.ts                    theme CSS + stage HTML assembly (assembleSlideHtml)
src/render/thumbs.ts                   Playwright screenshot service, single-worker queue, cache by hash
src/import/fromDeckHtml.ts             import deck.html -> deck folder
src/agent/session.ts                   persistent SDK session per deck, message routing, streaming events
src/agent/tools.ts                     createSdkMcpServer with deck tools
src/agent/permissions.ts               canUseTool hook: deny writes outside assets/
src/agent/checks/runner.ts             run a check as fresh query() with schema
src/agent/checks/{arc,order,gaps,render}.ts
src/agent/prompts.ts                   system prompt append + check prompts
src/server/app.ts                      fastify build(): routes + ws + static
src/server/routes/*.ts                 deck, slides, lanes, remarks, versions, brief, thumbs, threads, checks
src/server/ws.ts                       event bus -> websocket broadcast
src/cli/main.ts                        deckstudio <folder>
web/index.html, web/src/main.tsx, web/src/App.tsx
web/src/api.ts                         typed fetch + ws client
web/src/screens/{Main,Focus,BriefChecks,History,Present}.tsx
web/src/components/{Filmstrip,LaneRow,Thumb,ChangeButtons,Remark,Thread,ContextChip,VersionLine}.tsx
web/src/theme.css                      app design tokens (light)
tests/**                               mirrors src/**
tests/fixtures/deck-mini/              a 5-slide deck folder used by tests
e2e/smoke.test.ts                      real SDK, real Chromium (pnpm e2e)
decks/                                 imported decks (gitignored except .gitkeep)
```

---

# Milestone 1: model, import, render, main filmstrip

### Task 1: Scaffold (architect)

**Files:** package.json, tsconfig.json, vitest.config.ts, vite.config.ts, .gitignore, src/index.ts, web/index.html, web/src/main.tsx, tests/setup.ts, tests/helpers/waitFor.ts

- [ ] `pnpm init`; deps: fastify @fastify/websocket @fastify/static zod @anthropic-ai/claude-agent-sdk playwright nanoid react react-dom; dev: typescript vitest vite @vitejs/plugin-react tsx @types/node @types/react @types/react-dom
- [ ] scripts: `dev` (server tsx watch + vite), `build` (tsc + vite build), `typecheck` (tsc --noEmit -p . && tsc --noEmit -p web), `test` (vitest run), `e2e` (vitest run --config vitest.e2e.config.ts), `deckstudio` (node bin/deckstudio.js)
- [ ] `tests/helpers/waitFor.ts`:
```ts
export async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, opts = { timeout: 10_000, interval: 50 }): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > opts.timeout) throw new Error('waitFor: timeout');
    await new Promise(r => setTimeout(r, opts.interval));
  }
}
```
- [ ] `pnpm exec playwright install chromium`
- [ ] `pnpm typecheck && pnpm test` pass on an empty suite (one trivial test).

### Task 2: Model types, schemas, ops

**Files:** Create `src/model/types.ts`, `src/model/schema.ts`, `src/model/ids.ts`, `src/model/ops.ts`; Test `tests/model/ops.test.ts`, `tests/model/schema.test.ts`

**Interfaces (Produces, exact):**
```ts
// types.ts
export type SlideId = string;            // "s_" + 10 chars
export type SlideKind = 'cover' | 'diagram' | 'code' | 'text' | 'close';
export interface Slide { id: SlideId; title: string; story: string; notes: string; body: string; assets: string[]; kind: SlideKind }
export type SlidePatch = Partial<Pick<Slide, 'title' | 'story' | 'notes' | 'body' | 'assets' | 'kind'>>;
export interface Brief { title: string; audience: string; message: string; pattern: 'solution-first' | 'problem-driven'; abstract: string }
export interface DeckState { name: string; order: SlideId[]; version: number; sessionId: string | null; model: string }
export type Anchor = { kind: 'slide'; slide: SlideId } | { kind: 'range'; from: SlideId; to: SlideId } | { kind: 'arc' };
export type ChangeStatus = 'pending' | 'accepted' | 'refused' | 'orphan';
export type Change =
  | { id: string; kind: 'insert'; after: SlideId | null; slide: Slide; reason: string; status: ChangeStatus }
  | { id: string; kind: 'modify'; slide: SlideId; patch: SlidePatch; reason: string; status: ChangeStatus }
  | { id: string; kind: 'remove'; slide: SlideId; reason: string; status: ChangeStatus }
  | { id: string; kind: 'move'; slide: SlideId; after: SlideId | null; reason: string; status: ChangeStatus };
export interface Lane { id: string; label: string; anchor: Anchor; origin: 'user' | `check:${string}`; baseVersion: number; changes: Change[]; status: 'open' | 'closed'; createdAt: string }
export interface Remark { id: string; anchor: Anchor; text: string; origin: 'user' | `check:${string}`; severity: 'info' | 'warn'; status: 'open' | 'resolved'; laneId: string | null; createdAt: string }
export type VersionCause = { kind: 'import' } | { kind: 'accept'; laneId: string; changeId: string } | { kind: 'restore'; from: number; entry: string };
export interface Version { n: number; order: SlideId[]; slides: Record<SlideId, string /* hash */>; cause: VersionCause; createdAt: string }
export type ThreadKey = 'global' | `lane:${string}` | `remark:${string}`;
export interface ThreadMessage { id: string; thread: ThreadKey; role: 'user' | 'assistant'; text: string; context: Anchor | null; at: string }
export type DiffEntry =
  | { kind: 'added'; slide: SlideId; at: number }
  | { kind: 'removed'; slide: SlideId; wasAt: number }
  | { kind: 'modified'; slide: SlideId; fields: (keyof SlidePatch)[] }
  | { kind: 'moved'; slide: SlideId; from: number; to: number };
```
```ts
// ids.ts
export function newId(prefix: 's' | 'l' | 'c' | 'r' | 'm'): string;   // prefix + "_" + nanoid(10)
export function hashSlide(s: Slide): string;                            // sha256 hex of canonical JSON (sorted keys) of {title,story,notes,body,assets,kind}
```
```ts
// ops.ts
export interface Snapshot { order: SlideId[]; slides: Record<SlideId, Slide> }
export type ApplyResult = { ok: true; next: Snapshot } | { ok: false; error: string };
export function applyChange(snap: Snapshot, change: Change): ApplyResult;           // pure
export function rebaseLane(lane: Lane, snap: Snapshot): Lane;                        // marks changes whose referenced slides no longer exist as 'orphan'; leaves others untouched
export function diffVersions(a: Snapshot, b: Snapshot): DiffEntry[];                 // by slide id; modified compares field by field
export function validateBody(body: string): { ok: true } | { ok: false; reasons: string[] }; // rejects <ul>, <ol>, <script>, empty
export function slidesInRange(order: SlideId[], anchor: Anchor): SlideId[];
```
`schema.ts` exports zod schemas `SlideSchema`, `SlidePatchSchema`, `BriefSchema`, `AnchorSchema`, `ChangeSchema` (discriminated union on `kind`), `LaneSchema`, `RemarkSchema`, `VersionSchema`, `ThreadMessageSchema`, and AI-facing inputs: `ProposeLaneInput = { label, anchor, changes: NewChange[] }` where `NewChange` is `Change` without `id`/`status` and with `slide` for insert being `Omit<Slide,'id'>`; `ReviseLaneInput = { laneId, replaceChanges: NewChange[] }`; `AddRemarkInput = { anchor, text, severity }`.

- [ ] Test: `applyChange` insert after null puts the slide first; insert after X puts it right after X; modify patches only given fields; remove drops from order and slides; move relocates; unknown slide id returns `{ok:false}`.
- [ ] Test (Review Focus 1): lane with `modify s3` after `s3` was removed → `rebaseLane` sets that change `orphan`, other changes stay `pending`.
- [ ] Test (Review Focus 2): accepted `move s2 after s5`, then an `insert after s2` lands after s2's new position.
- [ ] Test: `diffVersions` returns added/removed/modified(fields)/moved correctly on a 5-slide fixture.
- [ ] Test: `validateBody` rejects `<ul>`, `<script>`, empty; accepts an `<img>` + `<div>` fragment.
- [ ] Test: `hashSlide` is stable across key order and changes when `body` changes.
- [ ] Implement, all green.

### Task 3: Deck store on disk

**Files:** Create `src/store/deckStore.ts`, `src/store/locks.ts`; Test `tests/store/deckStore.test.ts` (uses a temp dir per test)

**Interfaces:**
```ts
export class DeckStore {
  static async open(dir: string): Promise<DeckStore>;          // throws if deck.json missing
  static async init(dir: string, name: string, brief: Brief): Promise<DeckStore>;
  readonly dir: string;
  async state(): Promise<DeckState>;
  async brief(): Promise<Brief>;  async setBrief(b: Brief): Promise<void>;
  async snapshot(): Promise<Snapshot>;                         // current main
  async snapshotAt(n: number): Promise<Snapshot>;              // from versions/v{n}.json + objects
  async slide(id: SlideId): Promise<Slide | null>;
  async commit(next: Snapshot, cause: VersionCause): Promise<Version>; // writes objects/<hash>.json (if absent), slides/<id>.json, versions/v{n+1}.json, deck.json
  async versions(): Promise<Version[]>;
  async lanes(): Promise<Lane[]>;  async lane(id: string): Promise<Lane | null>;  async putLane(l: Lane): Promise<void>;
  async remarks(): Promise<Remark[]>;  async putRemarks(r: Remark[]): Promise<void>;
  async thread(key: ThreadKey): Promise<ThreadMessage[]>;  async appendMessage(m: ThreadMessage): Promise<void>; // threads/<key with ':' -> '_'>.jsonl
  async setSessionId(id: string | null): Promise<void>;
  async withLock<T>(fn: () => Promise<T>): Promise<T>;          // per-deck mutex (locks.ts)
}
```
Layout exactly as the spec: `brief.json`, `deck.json`, `slides/<id>.json`, `assets/`, `objects/<hash>.json`, `versions/v<n>.json`, `lanes/<id>.json`, `remarks.json`, `threads/*.jsonl`, `cache/thumbs/`.

- [ ] Test: `init` creates layout; `commit` twice yields v1, v2 with the same object reused when a slide is unchanged (one file in `objects/` for it).
- [ ] Test: `snapshotAt(1)` after two commits returns the older order and content.
- [ ] Test (Review Focus 5): two concurrent `withLock(commit)` produce v1 and v2, never two v1.
- [ ] Test: thread append/read round-trips, key `lane:abc` maps to `threads/lane_abc.jsonl`.

### Task 4: Import from deck.html

**Files:** Create `src/import/fromDeckHtml.ts`; Test `tests/import/fromDeckHtml.test.ts` with fixture `tests/fixtures/deck-3.html` (three sections copied from the SF deck: one image slide, one code slide, one typographic slide, plus the head CSS).

**Interfaces:**
```ts
export interface ImportResult { dir: string; slides: number; assetsCopied: number; themeCss: string }
export async function importDeckHtml(opts: { html: string; htmlDir: string; outDir: string; name: string; brief: Brief }): Promise<ImportResult>;
```
Rules: each `<section class="slide">` → one slide. `title` = text of the first `h1`/`h2`; `story` = `.story` text; `notes` = `aside.notes` text; `body` = the section's inner HTML minus h1/h2/.story/.notes/.strata; every `src="..."` relative path inside body is copied into `assets/` and rewritten to `assets/<basename>`; `kind` = `cover` for the first, `close` for the last, `code` if body contains `class="code"`, `diagram` if it contains `<img`, else `text`. Theme CSS = the first `<style>` block, saved to `<outDir>/theme.css` and returned. Uses `node-html-parser` (add dep, note in decisions.md) or the DOM from Playwright; prefer `node-html-parser`.

- [ ] Test: 3 sections → 3 slides with correct titles, kinds, story/notes; image path rewritten and file copied; `theme.css` non-empty and contains `.slide{`.
- [ ] Test: a section without `.story` yields `story: ""` and does not throw.
- [ ] Script `scripts/import-sf.ts`: imports `~/code/personal/data-streaming-summit-san-francisco-2026/deck.html` into `decks/dss-sf-2026` with the brief from the spec (title, audience "Kafka/Flink engineers and agent builders at Data Streaming Summit SF", message from the spine, pattern `solution-first`, abstract text). Run it; expect 29 slides.

### Task 5: Renderer and thumbnails

**Files:** Create `src/render/theme.ts`, `src/render/thumbs.ts`; Test `tests/render/theme.test.ts`, `tests/render/thumbs.test.ts` (real Chromium)

**Interfaces:**
```ts
export function assembleSlideHtml(slide: Pick<Slide,'title'|'body'|'kind'>, opts: { themeCss: string; assetsBaseUrl: string }): string;
// full HTML document: <style>themeCss</style> + <section class="slide active"> <h2 style=...>title</h2> + body (script tags stripped, src rewritten to assetsBaseUrl) + strata </section>; the stage is 1280x720 at scale 1.
export class ThumbService {
  constructor(opts: { cacheDir: string; themeCss: string; assetsDir: string; width?: 1280; height?: 720 });
  async start(): Promise<void>; async stop(): Promise<void>;
  async thumb(slide: Slide): Promise<{ path: string; hash: string; cached: boolean }>;   // queued, single worker; file cache/thumbs/<hash>.png
  async render(html: string): Promise<Buffer>;                                          // used by the AI's render_slide tool
}
```
- [ ] Test: `assembleSlideHtml` strips `<script>`, keeps `<img>`, rewrites `assets/x.png` to `${assetsBaseUrl}/x.png`; result contains the title once.
- [ ] Test (Review Focus 3): body `<div><b>unclosed` renders; screenshot is 1280x720 PNG (check PNG header width/height bytes).
- [ ] Test: two `thumb()` calls for the same slide → second is `cached: true`; a body change → new hash, new file.
- [ ] Test: 5 parallel `thumb()` calls complete (queue) and produce 5 files.

### Task 6: Server core

**Files:** Create `src/server/app.ts`, `src/server/ws.ts`, `src/server/routes/deck.ts`, `slides.ts`, `versions.ts`, `thumbs.ts`, `brief.ts`; Test `tests/server/deck.test.ts` (fastify `inject`, fixture deck)

**Interfaces:**
```ts
export async function buildApp(opts: { deckDir: string; thumbs: ThumbService; agent?: AgentSession }): Promise<FastifyInstance>;
// GET  /api/deck            -> { state: DeckState, brief: Brief, order: SlideId[], slides: Record<SlideId, Slide> }
// GET  /api/slides/:id      -> Slide | 404
// PATCH /api/slides/:id     body SlidePatch -> commits a version with cause {kind:'accept', laneId:'manual', changeId:'manual'} (creator's direct edit)
// GET  /api/versions        -> Version[]
// GET  /api/versions/:n     -> { order, slides }
// GET  /api/thumbs/:hash.png -> file (404 until rendered); GET /api/thumbs/for/:slideId -> { hash, ready: boolean } and enqueues
// GET  /assets/*            -> static from deck assets/
// GET  /api/brief, PUT /api/brief
// WS   /ws                  -> server pushes { type: 'thumb.ready', hash } | { type: 'deck.changed', version } | later agent events
```
`ws.ts`: `export class Bus { on(type, fn); emit(evt); attach(fastify) }`.
- [ ] Test: `GET /api/deck` returns 5 slides from fixture; `PATCH` title creates v2 and emits `deck.changed`; `GET /api/thumbs/for/:id` then `waitFor` file exists.

### Task 7: Web app: main filmstrip and present mode

**Files:** Create `web/src/App.tsx`, `web/src/api.ts`, `web/src/theme.css`, `web/src/screens/Main.tsx`, `web/src/screens/Present.tsx`, `web/src/components/Filmstrip.tsx`, `Thumb.tsx`, `VersionLine.tsx`; Test `tests/web/filmstrip.test.tsx` (vitest + @testing-library/react, jsdom)

**Interfaces:** `api.ts` exports `getDeck()`, `getVersions()`, `thumbUrl(hash)`, `subscribe(handler)` (WS with reconnect). `Filmstrip` props: `{ order: SlideId[]; slides: Record<SlideId, Slide>; thumbs: Record<SlideId, string|undefined>; selected?: SlideId; onSelect(id) }`. Layout per mockup 1: row label at left, thumbs 160x90 with number and title under, horizontal scroll, selection ring in accent. `Present` route `/present` renders main with the original player behaviour (arrows, `s` story panel, `n` notes to console) using `assembleSlideHtml` served by `GET /api/present` (add to Task 6 routes: returns a full HTML page listing all slides).
- [ ] Test: renders 5 thumbs in order, shows placeholders until thumb URLs arrive, calls `onSelect` on click.
- [ ] Manual: `pnpm dev` on `decks/dss-sf-2026` shows 29 thumbs; `/present` plays the deck.

**Milestone 1 exit:** `pnpm typecheck && pnpm test` green; `deckstudio decks/dss-sf-2026` shows the filmstrip; commit `M1: model, store, import, render, main filmstrip`.

---

# Milestone 2: agent session, lanes, accept per change, versions

### Task 8: Agent tools and permissions

**Files:** Create `src/agent/tools.ts`, `src/agent/permissions.ts`, `src/agent/prompts.ts`; Test `tests/agent/tools.test.ts` (calls tool handlers directly, no SDK), `tests/agent/permissions.test.ts`

**Interfaces:**
```ts
export function makeDeckTools(ctx: { store: DeckStore; thumbs: ThumbService; bus: Bus; imageGen: (prompt: string, size: string) => Promise<string /* asset path */> }): { server: McpSdkServerConfigWithInstance; allowedTools: string[] };
// tools (mcp__deck__*): get_deck(), get_slide({id}), render_slide({title, body, kind}) -> { png_path, warnings[] from validateBody }, propose_lane(ProposeLaneInput) -> { laneId, changes: [{id, summary}] }, revise_lane(ReviseLaneInput), add_remark(AddRemarkInput) -> { remarkId }, generate_image({prompt, size}) -> { asset }, run_check({name}) -> { started: true }
export function canUseTool(deckDir: string): CanUseTool; // deny Write/Edit/MultiEdit/NotebookEdit and Bash commands that write (rm, mv, >, tee, sed -i, cp into) anywhere under deckDir except deckDir/assets; allow everything else
```
`propose_lane` validates: anchor slides exist; every change references existing slides (or `after: null`); every insert body passes `validateBody`; returns a structured error `{ error: string, invalid: [...] }` on failure (Review Focus 4). Lane `baseVersion` = current version. Emits `lane.created` on the bus.
`prompts.ts`: `SYSTEM_APPEND` (co-author role, the composition rules, "use render_slide before proposing", "one idea per slide, no lists", how anchors work, "reply in the language of the message") and `contextHeader(anchorInfo, snapshotSummary)`.
- [ ] Test: propose_lane with an unknown slide id returns `{error}` and creates no lane file; with a valid insert creates `lanes/<id>.json` with status pending and correct baseVersion.
- [ ] Test: propose_lane with `<ul>` in an inserted body is rejected naming the change index.
- [ ] Test (permissions): `canUseTool` denies `Write` to `<deck>/slides/x.json`, allows `Write` to `<deck>/assets/a.png`, allows `Read` anywhere, denies `Bash` `rm -rf <deck>/slides`.

### Task 9: Lane operations and API

**Files:** Create `src/server/routes/lanes.ts`, `src/server/laneService.ts`; Test `tests/server/lanes.test.ts`

**Interfaces:**
```ts
export class LaneService {
  constructor(store: DeckStore, bus: Bus);
  async accept(laneId: string, changeId: string): Promise<{ version: Version; lane: Lane }>;  // under store.withLock: apply on current snapshot, commit, mark accepted, rebase ALL open lanes, close lane if no pending, emit deck.changed + lane.updated
  async refuse(laneId: string, changeId: string): Promise<Lane>;
  async closeLane(laneId: string): Promise<void>;
}
// GET /api/lanes -> Lane[] (open); GET /api/lanes/:id; POST /api/lanes/:id/changes/:cid/accept; POST .../refuse; DELETE /api/lanes/:id
// GET /api/lanes/:id/preview -> { order, slides } = snapshot with ALL pending changes of the lane applied (for thumbnails of the lane row); thumbs enqueued
```
- [ ] Test: accept one of two changes → v2, first change accepted, second pending; `GET /api/lanes/:id/preview` reflects the remaining change on top of v2.
- [ ] Test (Review Focus 5): two concurrent accepts on different lanes → v2 and v3, both applied.
- [ ] Test: accepting a change that removes s3 orphans another lane's `modify s3`.

### Task 10: Agent session and threads

**Files:** Create `src/agent/session.ts`, `src/server/routes/threads.ts`; Test `tests/agent/session.test.ts` (unit: routing and context header, SDK mocked by injecting a fake `query`), `e2e/smoke.test.ts` (real)

**Interfaces:**
```ts
export interface AgentEvent { type: 'assistant.delta'; thread: ThreadKey; text: string } | { type: 'assistant.done'; thread: ThreadKey; messageId: string } | { type: 'tool.call'; name: string } | { type: 'error'; message: string };
export class AgentSession {
  constructor(opts: { store: DeckStore; tools: ReturnType<typeof makeDeckTools>; bus: Bus; model: string; queryImpl?: typeof query });
  async send(thread: ThreadKey, text: string, context: Anchor | null): Promise<void>; // appends user message; builds prompt = contextHeader + text; runs SDK query with resume=state.sessionId, cwd=store.dir, settingSources ['user','project'], systemPrompt preset claude_code + append, mcpServers {deck}, allowedTools, canUseTool; streams AgentEvents on bus; appends assistant message to the same thread; persists session id
  async interrupt(): Promise<void>;
}
// POST /api/threads/:key/messages { text, context } -> 202; GET /api/threads/:key -> ThreadMessage[]
```
- [ ] Unit test: `send('lane:l1', ...)` builds a prompt whose header names the lane, its anchor range titles, and the pending changes; assistant text ends up in `threads/lane_l1.jsonl`.
- [ ] e2e (`pnpm e2e`, needs credentials; skip with a clear message if `claude` auth is absent): on the imported SF deck, `POST /api/threads/global/messages` with "Propose a lane on slides 1–6 that adds a hook slide before slide 2 explaining where memory should live; one change only" → `waitFor` a lane with ≥1 pending insert; accept it → v2 exists, `GET /api/deck` order has 30 ids, thumb for the new slide exists in `cache/thumbs`.

### Task 11: Web: lanes under main, change buttons, global thread

**Files:** Create `web/src/components/LaneRow.tsx`, `ChangeButtons.tsx`, `Thread.tsx`, `ContextChip.tsx`; modify `Main.tsx`, `api.ts`; Test `tests/web/laneRow.test.tsx`

Behaviour per mockup 1: a lane row spans only the columns of its anchor range (compute column index from `order`), aligned under main; inserted slides shown with accent outline and `+`, modified with accent dot, removed as dashed slot, moved with a thin connector; ✓ ✗ under each changed thumb call accept/refuse; lane label + origin tag (`unsolicited · from check: order`) + `discard lane`. Right panel: global thread with streaming text, context chip reflecting current selection (click a thumb → `slide`, shift-click → `range`, none → arc), input sends `{text, context}`. Bottom: `VersionLine`.
- [ ] Test: lane anchored s2..s4 renders with left offset = 1 column and 3 columns wide; clicking ✓ posts accept for that change id.

**Milestone 2 exit:** persona test (creator asks for a hook lane, accepts one change); fix top 3 frictions; `pnpm e2e` green; commit `M2: agent session, lanes, per-change accept`.

---

# Milestone 3: focus screen and local threads

### Task 12: Focus screen

**Files:** Create `web/src/screens/Focus.tsx`, `web/src/components/SlidePreview.tsx`; route `/lane/:laneId/change/:changeId`; Test `tests/web/focus.test.tsx`

Per mockup 2: left = main slide render (thumb at 560px wide), right = lane version (accent outline) rendered from `GET /api/lanes/:id/preview`; for `insert` left shows a dashed "not in main" card; reason under; buttons accept/refuse; prev/next change; bottom two filmstrips (main and lane) with the range underlined; right panel = local thread `lane:<id>`.
- [ ] Test: navigating next/prev cycles through the lane's pending changes only.

### Task 13: Local threads and "revise or fork"

**Files:** modify `src/agent/session.ts`, `src/agent/prompts.ts`; Test `tests/agent/session.test.ts`

A message on `lane:<id>` gets a header listing the lane's changes and the instruction: "If the creator asks for a modification of this lane, call revise_lane on it. If they ask for an alternative, call propose_lane with a new label and mention both in your reply." Remark threads `remark:<id>`: header includes the remark text and anchor; instruction: "If asked to propose, call propose_lane with origin from this remark and set the remark's laneId via add_remark? No: use `link_remark_lane({remarkId, laneId})`" → add tool `link_remark_lane` to Task 8's server (Interfaces updated here: `link_remark_lane({remarkId, laneId}) -> {ok}`).
- [ ] Unit test: header for `lane:l1` contains each change summary; header for `remark:r1` contains the remark text.

**Milestone 3 exit:** commit `M3: focus screen, local threads`.

---

# Milestone 4: checks, remarks, brief

### Task 14: Check runner and the four checks

**Files:** Create `src/agent/checks/runner.ts`, `arc.ts`, `order.ts`, `gaps.ts`, `render.ts`; Test `tests/agent/checks/runner.test.ts` (fake query returning canned JSON, including one invalid then one valid), `e2e/checks.test.ts` (real)

**Interfaces:**
```ts
export const CheckResultSchema = z.object({ remarks: z.array(z.object({ anchor: AnchorSchema, severity: z.enum(['info','warn']), text: z.string().min(1), lane: ProposeLaneInputSchema.nullable() })) });
export type CheckName = 'arc' | 'order' | 'gaps' | 'render';
export interface CheckDef { name: CheckName; buildPrompt(input: { brief: Brief; snap: Snapshot; thumbs?: Record<SlideId,string> }): string; needsThumbs: boolean }
export class CheckRunner {
  constructor(opts: { store: DeckStore; thumbs: ThumbService; bus: Bus; model: string; queryImpl?: typeof query });
  async run(name: CheckName, scope?: Anchor): Promise<{ remarks: Remark[]; lanes: Lane[] }>; // fresh query(), no session, no settingSources, output JSON validated; on invalid JSON retry once then produce one remark "check <name> failed: <reason>"; replaces previous remarks with origin check:<name> (and closes their unsolicited lanes if still fully pending); persists; emits remarks.changed
  scheduleAfterAccept(): void;   // debounce 3s, then run all four
  scheduleAfterLane(laneId: string): void; // render check on the lane's preview only
}
```
Prompts: `arc` (hook before slide 4? rising build-up? return to the opening? per brief.pattern), `order` (every concept used is introduced earlier; list violations with the slide where it's used and where it is first defined), `gaps` (compare brief.abstract and brief.message with slide titles+stories; list promises not covered), `render` (given thumbs: overflow, text under 24px, lists, more than one idea, empty stage). Each ends with the exact JSON contract.
- [ ] Test: invalid JSON then valid → result persisted, one retry; twice invalid → one failure remark.
- [ ] Test: running `order` twice replaces its earlier remarks without touching `arc` remarks.

### Task 15: Remarks and brief API + web screen

**Files:** Create `src/server/routes/remarks.ts`, `checks.ts`; `web/src/screens/BriefChecks.tsx`, `web/src/components/Remark.tsx`; modify `Main.tsx` (post-its on main); Test `tests/server/remarks.test.ts`, `tests/web/briefChecks.test.tsx`

Routes: `GET /api/remarks`, `POST /api/remarks` (creator remark), `POST /api/remarks/:id/resolve`, `POST /api/remarks/:id/propose` (sends to session on thread `remark:<id>` the message "Propose a lane for this remark"), `POST /api/checks/run` `{names?: CheckName[]}`, `GET /api/checks/status`.
Web per mockup 3: brief editable (PUT), checks list with status dot per check (green if no warn remarks), expandable rows with remark cards (anchor chip, text, `show` selects the anchor on Main, `propose`), "lane ready" preview when `laneId` set; right filmstrip highlighting anchored slides. Main: post-its attached to anchored thumbs with `propose`.
- [ ] Test: `propose` on a remark posts to `threads/remark:<id>`; resolving hides it from Main.

**Milestone 4 exit:** persona test (run checks, turn a remark into a lane); fix top 3; commit `M4: checks, remarks, brief`.

---

# Milestone 5: history and compare

### Task 16: History API

**Files:** Create `src/server/routes/history.ts`, `src/server/historyService.ts`; Test `tests/server/history.test.ts`

Routes: `GET /api/history/diff?a=3&b=6 -> DiffEntry[]` (via `diffVersions`); `POST /api/history/restore { from: n, entry: DiffEntry }` → applies the inverse of one entry onto current main as a new version with cause `restore`; `POST /api/history/open-as-lane { n }` → creates a lane `origin:'user'`, label `v<n>`, anchor arc, changes = the diff from current main to v<n> expressed as pending changes.
- [ ] Test: restore a removed slide re-inserts it at its old index bounded by current length; open-as-lane produces changes that, all accepted, reproduce v<n>'s order and content (property test on the fixture).

### Task 17: History screen

**Files:** Create `web/src/screens/History.tsx`; Test `tests/web/history.test.tsx`

Per mockup 4: version line with two selectable versions, two aligned filmstrips with diff marks and connectors, right panel "what changed" with `restore` per entry, button "open vN as a lane".
- [ ] Test: selecting v3 and v6 fetches the diff and renders one marker per entry.

**Milestone 5 exit:** persona test (compare, restore); commit `M5: history and compare`.

---

# Milestone 6: visual finish of the tool

### Task 18: deck-loop on the tool's screens

Invoke `frontend-design:frontend-design`, then `deck-loop` with three targets generated from mockups 1, 2, 4 ("this screen, as the version a top studio ships"), captures via agent-browser at 1440x900, fresh Opus judge per round, five rounds, exit at 8. Working dir `.deck-loop/` (gitignored). Log in `.deck-loop/rounds.md`.
- [ ] Exit: score ≥ 8 or documented stall; commit `M6: visual finish`.
