import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type React from 'react';
import type { Anchor, Slide, SlideId, ThreadKey, ThreadMessage } from '../../../src/model/types.js';
import type { BusEvent, ThreadApi } from '../api.js';
import { ContextChip } from './ContextChip.js';

export interface ThreadProps {
  threadKey: ThreadKey;
  /** Sent with every message; shown as the chip above the conversation. */
  context: Anchor;
  order: SlideId[];
  slides: Record<SlideId, Slide>;
  api: ThreadApi;
  /** Server events; returns the unsubscribe function. */
  subscribe(handler: (e: BusEvent) => void): () => void;
  onClearContext?(): void;
  title?: string;
}

const time = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const TOOL_WORDS: Record<string, string> = {
  mcp__deck__get_deck: 'reading the deck', mcp__deck__get_slide: 'reading a slide', mcp__deck__render_slide: 'rendering a draft',
  mcp__deck__propose_lane: 'proposing a lane', mcp__deck__revise_lane: 'revising the lane', mcp__deck__add_remark: 'writing a remark',
  mcp__deck__generate_image: 'generating an image', mcp__deck__run_check: 'running a check', mcp__deck__link_remark_lane: 'linking the remark',
  Read: 'reading a file', Glob: 'listing files', Grep: 'searching files', Bash: 'running a command', WebFetch: 'fetching a page', WebSearch: 'searching the web',
};
export function describeTool(name: string): string {
  return TOOL_WORDS[name] ?? name.replace(/^mcp__deck__/, '').replace(/_/g, ' ');
}

/** Minimal inline markdown: **bold**, `code`, *italic*. Anything else stays as written. */
export function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let last = 0; let k = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k++} className="mono">{tok.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = i + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A conversation with the co-author. The reply streams in from `assistant.delta`; on `assistant.done` the stored thread is reloaded. */
export function Thread({ threadKey, context, order, slides, api, subscribe, onClearContext, title = 'thread' }: ThreadProps) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState('');
  const [tool, setTool] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.getThread(threadKey);
      setMessages(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [api, threadKey]);

  useEffect(() => {
    setMessages([]);
    setStreaming('');
    void load();
    return subscribe((e) => {
      if (!('thread' in e) || e.thread !== threadKey) return;
      if (e.type === 'assistant.delta') {
        setStreaming((s) => s + e.text);
        setTool(null);
      } else if (e.type === 'tool.call') {
        setTool(e.name);
      } else if (e.type === 'assistant.done') {
        setTool(null);
        void load().then(() => setStreaming(''));
      } else if (e.type === 'agent.error') {
        setTool(null);
        setStreaming('');
        setAgentError(e.message);
      }
    });
  }, [threadKey, load, subscribe]);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, streaming]);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setAgentError(null);
    const local: ThreadMessage = { id: `local-${Date.now()}`, thread: threadKey, role: 'user', text, context, at: new Date().toISOString() };
    setMessages((m) => [...m, local]);
    setDraft('');
    try {
      await api.postMessage(threadKey, text, context);
    } catch (err) {
      setMessages((m) => m.filter((x) => x.id !== local.id));
      setDraft(text);
      setAgentError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-testid="thread" data-thread={threadKey} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '18px 20px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
        <div>
          <ContextChip context={context} order={order} slides={slides} onClear={onClearContext} />
        </div>
      </div>
      <div role="log" aria-live="polite" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loadError ? <p style={{ color: 'var(--warn)', fontSize: 12, margin: 0 }}>Could not load the thread: {loadError}</p> : null}
        {!loadError && messages.length === 0 && !streaming ? (
          <p className="muted" style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
            Ask the co-author for a change. Select a slide (shift-click for a range) to anchor the request; with nothing selected it applies to the whole deck.
          </p>
        ) : null}
        {messages.map((m) => (
          <div key={m.id} data-testid="thread-message" data-role={m.role} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
              <strong style={{ color: m.role === 'assistant' ? 'var(--accent)' : 'var(--ink)' }}>{m.role === 'assistant' ? 'co-author' : 'you'}</strong>
              <span className="muted">{time(m.at)}</span>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{renderInline(m.text)}</div>
          </div>
        ))}
        {streaming || tool ? (
          <div data-testid="thread-streaming" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <strong style={{ fontSize: 12, color: 'var(--accent)' }}>co-author</strong>
            {streaming ? <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{streaming}</div> : null}
            {tool ? <span className="muted" style={{ fontSize: 11 }}>{describeTool(tool)}…</span> : null}
          </div>
        ) : null}
        {agentError ? (
          <p role="alert" style={{ color: 'var(--warn)', fontSize: 12, margin: 0 }}>
            {agentError}
          </p>
        ) : null}
        <div ref={bottom} />
      </div>
      <form onSubmit={(e) => void submit(e)} style={{ display: 'flex', gap: 8, padding: 16, borderTop: '1px solid var(--line)' }}>
        <input
          aria-label="message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a message…"
          style={{ flex: 1, minWidth: 0, padding: '9px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', font: 'inherit', color: 'var(--ink)' }}
        />
        <button
          type="submit"
          disabled={sending || draft.trim() === ''}
          style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--card)', fontWeight: 700, cursor: 'pointer', opacity: sending || draft.trim() === '' ? 0.6 : 1 }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
