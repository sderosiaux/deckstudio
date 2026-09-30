import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

export type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const DENY_HINT =
  'The deck folder is read-only for you except assets/. Propose slide changes with mcp__deck__propose_lane (or mcp__deck__revise_lane); put generated files under assets/.';

// ---------------------------------------------------------------------------
// Path classification

/** Resolves symlinks on the deepest existing ancestor so /var and /private/var compare equal. */
function canonical(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return p;
    tail.unshift(basename(head));
    head = parent;
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return p;
  }
}

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

interface Zone {
  /** Inside the deck but not under assets/. */
  protectedPath(p: string): boolean;
  /** The deck folder itself or one of its ancestors: deleting or moving it destroys the deck. */
  containsDeck(p: string): boolean;
}

function zone(deckDir: string): Zone {
  const roots = [...new Set([resolve(deckDir), canonical(resolve(deckDir))])];
  const forms = (p: string) => [...new Set([p, canonical(p)])];
  return {
    protectedPath: (p) => forms(p).some((q) => roots.some((r) => inside(r, q) && !inside(join(r, 'assets'), q))),
    containsDeck: (p) => forms(p).some((q) => roots.some((r) => inside(q, r))),
  };
}

// ---------------------------------------------------------------------------
// Bash command analysis

type Tok = { kind: 'word'; text: string } | { kind: 'sep' } | { kind: 'redir' };

/** Minimal shell lexer: quotes, escapes, command separators and output redirections. */
function lex(command: string): Tok[] {
  const out: Tok[] = [];
  let word = '';
  let inWord = false;
  const flush = () => {
    if (inWord) out.push({ kind: 'word', text: word });
    word = '';
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      word += command.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (ch === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '\\' && j + 1 < command.length) j++;
        word += command[j];
      }
      i = j;
    } else if (ch === '\\' && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (ch === '\n') {
        flush();
        out.push({ kind: 'sep' });
      } else flush();
    } else if (ch === ';' || ch === '|' || ch === '(' || ch === ')' || ch === '`' || (ch === '&' && command[i + 1] !== '>')) {
      flush();
      out.push({ kind: 'sep' });
    } else if (ch === '>' || (ch === '&' && command[i + 1] === '>')) {
      // An fd prefix like `2>` belongs to the redirection, not to the word before it.
      if (/^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else flush();
      if (ch === '&') i++;
      while (command[i + 1] === '>' || command[i + 1] === '|') i++;
      if (command[i + 1] === '&') {
        // `>&2`, `2>&1`: duplicating a file descriptor, not a file target.
        const m = /^&(\d+|-)/.exec(command.slice(i + 1));
        if (m) {
          i += m[0].length;
          continue;
        }
        i++;
      }
      out.push({ kind: 'redir' });
    } else {
      word += ch;
      inWord = true;
    }
  }
  flush();
  return out;
}

interface Segment {
  words: string[];
  redirects: string[];
}

function segments(command: string): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment = { words: [], redirects: [] };
  let pendingRedir = false;
  for (const t of lex(command)) {
    if (t.kind === 'sep') {
      if (cur.words.length || cur.redirects.length) segs.push(cur);
      cur = { words: [], redirects: [] };
      pendingRedir = false;
    } else if (t.kind === 'redir') {
      pendingRedir = true;
    } else if (pendingRedir) {
      cur.redirects.push(t.text);
      pendingRedir = false;
    } else cur.words.push(t.text);
  }
  if (cur.words.length || cur.redirects.length) segs.push(cur);
  return segs;
}

/** Positional args, skipping flags and the values of flags that take one. */
function positionals(args: string[], valueFlags: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function flagValue(args: string[], names: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (names.includes(a)) return args[i + 1] ?? null;
    for (const n of names) if (n.startsWith('--') && a.startsWith(`${n}=`)) return a.slice(n.length + 1);
  }
  return null;
}

interface Targets {
  /** Paths that get created or overwritten. */
  writes: string[];
  /** Paths that get deleted or moved away (a deck ancestor here destroys the deck). */
  destroys: string[];
}

const COPY_VALUE_FLAGS = ['-t', '-S', '--suffix', '-m', '-o', '-g', '--target-directory'];

function commandTargets(cmd: string, args: string[], cwdProtected: boolean): Targets {
  const none: Targets = { writes: [], destroys: [] };
  switch (cmd) {
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
      return { writes: [], destroys: positionals(args, ['-n', '--iterations', '-s', '--size']) };
    case 'mv':
      return { writes: [], destroys: positionals(args, COPY_VALUE_FLAGS).concat(flagValue(args, ['-t', '--target-directory']) ?? []) };
    case 'cp':
    case 'install':
    case 'ln':
    case 'rsync': {
      const t = flagValue(args, ['-t', '--target-directory']);
      if (t) return { writes: [t], destroys: [] };
      const pos = positionals(args, COPY_VALUE_FLAGS);
      return { writes: pos.slice(-1), destroys: [] };
    }
    case 'tee':
      return { writes: positionals(args), destroys: [] };
    case 'truncate':
      return { writes: positionals(args, ['-s', '--size', '-r', '--reference']), destroys: [] };
    case 'touch':
      return { writes: positionals(args, ['-d', '-r', '-t']), destroys: [] };
    case 'sed':
    case 'perl': {
      const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
      if (!inPlace) return none;
      const scriptFlags = cmd === 'perl' ? ['-e', '-E'] : ['-e', '-f', '--expression', '--file'];
      const hasScriptFlag = args.some((a) => scriptFlags.includes(a));
      const pos = positionals(args, cmd === 'perl' ? [...scriptFlags, '-I', '-M', '-m'] : [...scriptFlags, '-l']).filter((a) => a !== '');
      return { writes: hasScriptFlag ? pos : pos.slice(1), destroys: [] };
    }
    case 'dd':
      return { writes: args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)), destroys: [] };
    case 'curl': {
      const o = flagValue(args, ['-o', '--output']);
      return { writes: o ? [o] : [], destroys: [] };
    }
    case 'wget': {
      const o = flagValue(args, ['-O', '--output-document']);
      return { writes: o ? [o] : [], destroys: [] };
    }
    case 'find': {
      const destructive = args.includes('-delete') || args.some((a, i) => (a === '-exec' || a === '-execdir') && /^(rm|mv|shred|truncate)$/.test(args[i + 1] ?? ''));
      if (!destructive) return none;
      const roots: string[] = [];
      for (const a of args) {
        if (a.startsWith('-') || a === '(' || a === '!') break;
        roots.push(a);
      }
      return { writes: [], destroys: roots.length ? roots : ['.'] };
    }
    case 'git': {
      const sub = positionals(args, ['-C', '-c', '--git-dir', '--work-tree'])[0];
      if (!sub || !['checkout', 'reset', 'restore', 'clean', 'rm', 'mv', 'stash', 'switch'].includes(sub)) return none;
      const rest = positionals(args.slice(args.indexOf(sub) + 1), ['-b', '-B', '--source', '-s', '-m']);
      // With no explicit path, these rewrite the whole working tree, which includes the cwd.
      return { writes: [], destroys: rest.length ? rest : cwdProtected ? ['.'] : [] };
    }
    default:
      return none;
  }
}

/** Returns the first deck path (outside assets/) the command would write, or null. */
function bashViolation(command: string, deckDir: string, z: Zone): string | null {
  let cwd = resolve(deckDir);
  const toPath = (w: string, base: string): string | null => {
    if (w === '' || w.includes('$')) return null;
    if (w === '~') return homedir();
    if (w.startsWith('~/')) return resolve(homedir(), w.slice(2));
    return resolve(base, w);
  };
  for (const seg of segments(command)) {
    let words = seg.words;
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1);
    while (words.length && ['sudo', 'command', 'exec', 'nice', 'nohup', 'time'].includes(words[0]!)) words = words.slice(1);
    for (const r of seg.redirects) {
      const p = toPath(r, cwd);
      if (p && z.protectedPath(p)) return p;
    }
    const [cmd, ...args] = words;
    if (!cmd) continue;
    if (cmd === 'cd' || cmd === 'pushd') {
      cwd = toPath(args[0] ?? '~', cwd) ?? cwd;
      continue;
    }
    const base = cmd === 'git' ? (toPath(flagValue(args, ['-C']) ?? '.', cwd) ?? cwd) : cwd;
    const t = commandTargets(basename(cmd), args, z.protectedPath(base));
    for (const w of t.writes) {
      const p = toPath(w, base);
      if (p && z.protectedPath(p)) return p;
    }
    for (const w of t.destroys) {
      const p = toPath(w, base);
      if (p && (z.protectedPath(p) || z.containsDeck(p))) return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * Permission hook for the co-author session. The deck folder is the source of truth and only
 * changes through lanes the creator accepts, so the model may not write anything in it except
 * under assets/. Bash analysis is a best-effort lexer over common writing verbs and redirections;
 * it does not see writes performed inside interpreters (python -c, node -e) or via xargs.
 */
export function canUseTool(deckDir: string): CanUseTool {
  const z = zone(deckDir);
  const root = resolve(deckDir);
  return async (toolName, input) => {
    const allow = { behavior: 'allow' as const, updatedInput: input };
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const raw = input.file_path ?? input.notebook_path;
      if (typeof raw === 'string' && raw !== '') {
        const p = resolve(root, raw);
        if (z.protectedPath(p)) return { behavior: 'deny', message: `${toolName} on ${p} denied. ${DENY_HINT}` };
      }
      return allow;
    }
    if (toolName === 'Bash' && typeof input.command === 'string') {
      const hit = bashViolation(input.command, deckDir, z);
      if (hit) return { behavior: 'deny', message: `Bash denied: the command would modify ${hit}. ${DENY_HINT}` };
    }
    return allow;
  };
}
