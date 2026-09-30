# Decisions

- 2026-09-30 · `node-html-parser` added for the deck.html import (Task 4): parsing sections without a browser keeps the import synchronous and testable without Chromium.
- 2026-09-30 · `ws` added alongside `@fastify/websocket` only if the fastify plugin proves insufficient for the bus; remove if unused at M2 integration.
- 2026-09-30 · `jsdom` + `@testing-library/react` for web unit tests; Playwright reserved for render and e2e.
