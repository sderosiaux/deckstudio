import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { newId } from '../model/ids.js';
import type { Anchor, Lane, Remark, ThreadKey, ThreadMessage } from '../model/types.js';
import type { Bus } from '../server/bus.js';
import type { DeckStore } from '../store/deckStore.js';
import { canUseTool } from './permissions.js';
import { contextHeader, SYSTEM_APPEND } from './prompts.js';
import type { makeDeckTools } from './tools.js';

export type AgentEvent =
  | { type: 'assistant.delta'; thread: ThreadKey; text: string }
  | { type: 'assistant.done'; thread: ThreadKey; messageId: string }
  | { type: 'tool.call'; name: string; thread: ThreadKey }
  | { type: 'agent.error'; message: string; thread: ThreadKey };

export interface AgentSessionOptions {
  store: DeckStore;
  tools: ReturnType<typeof makeDeckTools>;
  bus: Bus;
  model: string;
  deckDir: string;
  queryImpl?: typeof query;
}

/**
 * Only the deck tools are pre-approved. Built-in tools (Read, Bash, Write...) are deliberately NOT in
 * allowedTools: a bare allowedTools entry auto-approves the tool before canUseTool is consulted, which
 * would bypass the deck-folder write guard. They fall through to canUseTool, which allows reads and
 * denies writes under the deck folder.
 */
const BUILTIN_TOOLS: string[] = [];
const MAX_TURNS = 40;

/** The CLI's error text when `resume` names a session whose transcript no longer exists. */
const STALE_SESSION = 'No conversation found';

interface TurnOutcome {
  streamed: string[];
  finalTexts: string[];
  resultError: string | null;
  failure: string | null;
  staleSession: boolean;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One Claude Agent SDK session per deck. Every thread (global, lane:*, remark:*) talks to the same
 * session: the thread only changes the context header and where the reply is stored. Sends are
 * serialized so a deck never has two queries in flight and the resumed session id stays linear.
 */
export class AgentSession {
  private readonly opts: AgentSessionOptions;
  private readonly queryImpl: typeof query;
  private tail: Promise<void> = Promise.resolve();
  // Thread writes go through one chain so messages land in call order, even while a turn is running.
  private writes: Promise<void> = Promise.resolve();
  private running: AbortController | null = null;
  // Bumped by interrupt(): a turn queued under an older generation is dropped instead of run.
  private generation = 0;

  constructor(opts: AgentSessionOptions) {
    this.opts = opts;
    this.queryImpl = opts.queryImpl ?? query;
  }

  /** Resolves when this message's turn is over (reply stored, or error emitted). Never rejects on agent errors. */
  async send(thread: ThreadKey, text: string, context: Anchor | null): Promise<void> {
    const generation = this.generation;
    const user: ThreadMessage = { id: newId('m'), thread, role: 'user', text, context, at: new Date().toISOString() };
    await this.append(user);
    // The user message stays in the thread even when the turn is dropped by an interrupt: it was said.
    const turn = this.tail.then(() =>
      generation === this.generation ? this.run(thread, text, context) : this.opts.bus.emit({ type: 'agent.error', message: 'interrupted', thread }),
    );
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  private append(m: ThreadMessage): Promise<void> {
    const w = this.writes.then(() => this.opts.store.appendMessage(m));
    this.writes = w.catch(() => undefined);
    return w;
  }

  /**
   * Aborts the running turn, drops every turn queued before this call, and resolves once the queue has
   * drained and every thread write has landed, so nothing writes into the deck after it returns.
   */
  async interrupt(): Promise<void> {
    this.generation += 1;
    this.running?.abort();
    await this.tail;
    await this.writes;
  }

  private async buildPrompt(thread: ThreadKey, text: string, context: Anchor | null): Promise<string> {
    const { store } = this.opts;
    const [snapshot, brief] = await Promise.all([store.snapshot(), store.brief()]);
    let lane: Lane | undefined;
    let remark: Remark | undefined;
    if (thread.startsWith('lane:')) lane = (await store.lane(thread.slice('lane:'.length))) ?? undefined;
    if (thread.startsWith('remark:')) {
      const id = thread.slice('remark:'.length);
      remark = (await store.remarks()).find((r) => r.id === id);
    }
    const header = contextHeader({ thread, anchor: context, snapshot, brief, ...(lane ? { lane } : {}), ...(remark ? { remark } : {}) });
    return `${header}\n\n${text}`;
  }

  private async run(thread: ThreadKey, text: string, context: Anchor | null): Promise<void> {
    const { store, bus } = this.opts;
    const emit = (e: AgentEvent) => bus.emit(e);
    const abortController = new AbortController();
    this.running = abortController;

    let outcome: TurnOutcome = { streamed: [], finalTexts: [], resultError: null, failure: null, staleSession: false };
    try {
      const prompt = await this.buildPrompt(thread, text, context);
      const { sessionId } = await store.state();
      outcome = await this.attempt(thread, prompt, sessionId, abortController);
      if (outcome.staleSession) {
        // The stored session is gone (e.g. its transcript was deleted): start a fresh one, once.
        await store.setSessionId(null);
        outcome = await this.attempt(thread, prompt, null, abortController);
      }
    } catch (e) {
      outcome = { ...outcome, failure: abortController.signal.aborted ? 'interrupted' : errorMessage(e) };
    } finally {
      if (this.running === abortController) this.running = null;
    }

    const { streamed, finalTexts, resultError, failure } = outcome;
    const reply = finalTexts.length ? finalTexts.join('\n\n') : streamed.join('');
    // The SDK throws after yielding an error result; report the result's own reason once, not both.
    const error = resultError ?? failure;
    // A successful turn always ends with assistant.done (even when the model only called tools), so the
    // UI can close the turn; a failed turn keeps whatever text it produced before failing.
    if (!error || reply.trim() !== '') {
      const msg: ThreadMessage = { id: newId('m'), thread, role: 'assistant', text: reply, context: null, at: new Date().toISOString() };
      try {
        await this.append(msg);
        emit({ type: 'assistant.done', thread, messageId: msg.id });
      } catch (e) {
        emit({ type: 'agent.error', message: `could not store the reply: ${errorMessage(e)}`, thread });
      }
    }
    if (error) emit({ type: 'agent.error', message: error, thread });
  }

  /** One query. Never throws: a thrown SDK error ends up in `failure`. */
  private async attempt(thread: ThreadKey, prompt: string, resume: string | null, abortController: AbortController): Promise<TurnOutcome> {
    const { store, tools, bus, model, deckDir } = this.opts;
    const emit = (e: AgentEvent) => bus.emit(e);
    const out: TurnOutcome = { streamed: [], finalTexts: [], resultError: null, failure: null, staleSession: false };
    if (abortController.signal.aborted) return { ...out, failure: 'interrupted' };
    try {
      const q = this.queryImpl({
        prompt,
        options: {
          cwd: deckDir,
          model,
          ...(resume ? { resume } : {}),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
          settingSources: ['user', 'project'],
          mcpServers: { deck: tools.server },
          allowedTools: [...tools.allowedTools, ...BUILTIN_TOOLS],
          canUseTool: canUseTool(deckDir),
          permissionMode: 'default',
          includePartialMessages: true,
          maxTurns: MAX_TURNS,
          abortController,
        },
      });

      let inToolUse = false;
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === 'stream_event') {
          // Sub-agent streams carry parent_tool_use_id; only the top-level reply is shown in the thread.
          if (m.parent_tool_use_id) continue;
          const ev = m.event;
          if (ev.type === 'content_block_start') {
            if (ev.content_block.type === 'tool_use') {
              inToolUse = true;
              emit({ type: 'tool.call', name: ev.content_block.name, thread });
            }
          } else if (ev.type === 'content_block_stop') {
            inToolUse = false;
          } else if (ev.type === 'content_block_delta' && !inToolUse && ev.delta.type === 'text_delta') {
            out.streamed.push(ev.delta.text);
            emit({ type: 'assistant.delta', thread, text: ev.delta.text });
          }
        } else if (m.type === 'assistant') {
          if (m.parent_tool_use_id) continue;
          const t = m.message.content
            .flatMap((b) => (b.type === 'text' ? [b.text] : []))
            .join('');
          if (t.trim() !== '') out.finalTexts.push(t);
        } else if (m.type === 'result') {
          const stale = m.subtype === 'error_during_execution' && m.errors.some((e) => e.includes(STALE_SESSION));
          // Any result but "that session does not exist" leaves a transcript worth resuming (error_max_turns included).
          if (!stale) await store.setSessionId(m.session_id);
          if (m.subtype === 'success') {
            if (m.is_error) out.resultError = m.result;
          } else if (stale && resume) {
            out.staleSession = true;
            break;
          } else {
            out.resultError = `${m.subtype}${m.errors.length ? `: ${m.errors.join('; ')}` : ''}`;
          }
        }
      }
    } catch (e) {
      out.failure = abortController.signal.aborted ? 'interrupted' : errorMessage(e);
    }
    return out;
  }
}
