import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHome } from '../src/cli/home.js';
import { importDeckHtmlFile } from '../src/import/fromDeckHtml.js';
import { DeckStore } from '../src/store/deckStore.js';
import { access, rename } from 'node:fs/promises';
import type { Brief } from '../src/model/types.js';

const source = join(homedir(), 'code/personal/data-streaming-summit-san-francisco-2026/deck.html');
// Into the home folder the CLI serves (DECKSTUDIO_HOME, else the repo's decks/ when present, else ~/deckstudio/decks).
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(await defaultHome(process.env, repo), 'dss-sf-2026');

// Abstract copied verbatim from the talk project's notes.txt (the submitted CFP abstract).
const brief: Brief = {
  title: 'Event-Driven Memory for LLM Agent Swarms',
  audience: 'Kafka and Flink engineers, agent builders, Data Streaming Summit SF 2026',
  message:
    'Kafka already has the right concepts for an agent swarm: the log is the recorded truth, every memory is a projection over it, agents and workers are disposable compute, and the AI is one more class of operator inside the architecture.',
  pattern: 'solution-first',
  abstract:
    'Ever built a multi-agent system on Kafka and wondered where the memory should live? An external database? But Kafka is a durable log, the conversation and reasoning are already there in your topics, ordered and replayable. Agents are just microservices with a brain (LLM, tools and memory).\n\n' +
    'This talk shows how to build a shared brain entirely on Kafka, with three tiers of memory: private topics per agent for scoped working memory, shared topics materialized into a queryable context store via Kafka Streams and Interactive Queries, and a vector DB for long-term semantic recall. MCP exposes that memory and the tools to the agents; share groups (Kafka queues) scale the slow, non-deterministic workers doing inference.',
  design: {
    rules:
      'Stage 1280x720 on paper #FAF9F6, ink #17171A, one accent #E4572E, warm light greys; Archivo for all text, IBM Plex Mono only for code and identifiers.\n' +
      'One claim per slide: the title states the message in sentence case (about 82px, top of the stage), no eyebrow above it, no "X not Y" framing, no question as a title.\n' +
      'No bullet lists, no markdown, no paragraph or sentence under a visual: a visual stands alone with short large labels; the story of the slide lives in its story field, not on the stage.\n' +
      'Visuals are flat, strictly frontal 2D illustrations in the keynote diagram style (no isometric view, no sketch, no photo, no gradient), generated as PNG assets that fill the stage width between the margins (x 96..1184, y 160..640).\n' +
      'Code slides use the .code card: real, tested Kafka 4.3 Java or pretty-printed highlighted JSON (never YAML), at most 14 lines, never truncated to fit; split into two slides instead.\n' +
      'Never add meta slides (agenda, recap, "what we learned"), no emoji, no stock icons, no decorative shapes.\n',
    imageStyle: '',
  },
};

const force = process.argv.slice(2).includes('--force');
if (await access(outDir).then(() => true, () => false)) {
  if (!force) {
    console.error(`${outDir} already exists; pass --force to move it aside to a timestamped backup and re-import`);
    process.exit(2);
  }
  const backup = `${outDir}.bak-${new Date().toISOString().replace(/:/g, '-')}`;
  await rename(outDir, backup);
  console.log(`moved existing deck to ${backup}`);
}
const res = await importDeckHtmlFile(source, { outDir, name: 'dss-sf-2026', brief, store: DeckStore });
console.log(`imported ${res.slides} slides, ${res.assetsCopied} assets into ${res.dir}`);
