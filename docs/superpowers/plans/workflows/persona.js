export const meta = {
  name: 'deckstudio-persona',
  description: 'Persona test: the creator of the SF talk uses the real tool through agent-browser and reports frictions',
  phases: [{ title: 'Persona', detail: 'one Opus agent drives the UI' }],
}
// args: { url, milestone, scenario }
const { url, milestone, scenario } = args
const SCHEMA = { type: 'object', properties: {
  completed: { type: 'boolean' }, steps_done: { type: 'array', items: { type: 'string' } },
  frictions: { type: 'array', items: { type: 'object', properties: { rank: { type: 'number' }, where: { type: 'string' }, what: { type: 'string' }, expected: { type: 'string' }, severity: { type: 'string', enum: ['blocking', 'major', 'minor'] } }, required: ['rank', 'where', 'what', 'expected', 'severity'] } },
  screenshots: { type: 'array', items: { type: 'string' } }, verdict: { type: 'string' } }, required: ['completed', 'steps_done', 'frictions', 'verdict'] }
phase('Persona')
const r = await agent(`Invoke the agents:persona-test skill if available; otherwise play the persona directly.
Persona: Stéphane, CTO, builds his own conference decks, thinks in narrative arcs, allergic to bullet slides and to tools that hide what changed. He is testing deckstudio (milestone "${milestone}") on his real talk "Event-Driven Memory for LLM Agent Swarms".
Use the agent-browser CLI (it is installed: agent-browser open <url>, agent-browser snapshot, agent-browser click <selector or @ref>, agent-browser fill, agent-browser type, agent-browser screenshot, agent-browser eval "<js>", agent-browser scroll). Set viewport 1440x900 first (agent-browser set viewport 1440 900). The app is running at ${url}.
Scenario to accomplish, as the persona would, without reading the source code: ${scenario}
Be patient with the AI co-author: after sending a message, poll with snapshot every 10 s for up to 4 minutes for a lane to appear.
Save screenshots to /tmp/deckstudio-persona-${milestone}-<n>.png at each key moment.
Report: whether the scenario completed; the steps done; frictions ranked by how much they would make this persona stop using the tool (blocking = cannot complete, major = completes but annoyed or confused, minor = polish), each with where (screen/element), what happened, what the persona expected; a one-paragraph verdict in the persona's voice.`, { label: `persona:${milestone}`, phase: 'Persona', schema: SCHEMA, model: 'opus' })
return r
