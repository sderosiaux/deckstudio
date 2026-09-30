# Decisions

- 2026-09-30 · `node-html-parser` added for the deck.html import (Task 4): parsing sections without a browser keeps the import synchronous and testable without Chromium.
- 2026-09-30 · `ws` added alongside `@fastify/websocket` only if the fastify plugin proves insufficient for the bus; remove if unused at M2 integration.
- 2026-09-30 · `jsdom` + `@testing-library/react` for web unit tests; Playwright reserved for render and e2e.
- 2026-09-30 · hashSlide = sha256 of recursively key-sorted JSON of {title,story,notes,body,assets,kind}, id excluded (content-addressed objects). Task 3's fixed-key-order variant dropped at merge.
- 2026-09-30 · Slide.assets stores the same string as the body src ("assets/<basename>"), not a bare name.
- 2026-09-30 · Thumbnails load Archivo and IBM Plex Mono from Google Fonts at render time; offline renders fall back to system fonts rather than bundling font files.
- 2026-09-30 · diffVersions reports "moved" by rank change among common ids (may over-report after one move); acceptable for v1, revisit with an LIS rule if the history screen reads badly.
