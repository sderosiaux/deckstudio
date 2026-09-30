import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDeckHtmlFile } from '../src/import/fromDeckHtml.js';
import { DeckStore } from '../src/store/deckStore.js';
import { access, rename } from 'node:fs/promises';
import type { Brief } from '../src/model/types.js';

const source = join(homedir(), 'code/personal/data-streaming-summit-san-francisco-2026/deck.html');
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'decks', 'dss-sf-2026');

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
