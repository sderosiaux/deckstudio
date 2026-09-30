# Decisions

- 2026-09-30 · `node-html-parser` added for the deck.html import (Task 4): parsing sections without a browser keeps the import synchronous and testable without Chromium.
- 2026-09-30 · `ws` added alongside `@fastify/websocket` only if the fastify plugin proves insufficient for the bus; remove if unused at M2 integration.
- 2026-09-30 · `jsdom` + `@testing-library/react` for web unit tests; Playwright reserved for render and e2e.
- 2026-09-30 · hashSlide = sha256 of recursively key-sorted JSON of {title,story,notes,body,assets,kind}, id excluded (content-addressed objects). Task 3's fixed-key-order variant dropped at merge.
- 2026-09-30 · Slide.assets stores the same string as the body src ("assets/<basename>"), not a bare name.
- 2026-09-30 · Thumbnails load Archivo and IBM Plex Mono from Google Fonts at render time; offline renders fall back to system fonts rather than bundling font files.
- 2026-09-30 · diffVersions reports "moved" by rank change among common ids (may over-report after one move); acceptable for v1, revisit with an LIS rule if the history screen reads badly.
- 2026-09-30 · Slide bodies are sanitized with DOMPurify over jsdom (allowlist, balanced re-serialization) instead of regexes: the M1 review broke the regex sanitizer three different ways. The present page also gets a CSP with a nonce for the player script.
- 2026-09-30 · Archivo and IBM Plex Mono woff2 (latin) are vendored under src/render/fonts and served through the render asset origin and /fonts on the app, so renders are deterministic offline and font bytes are part of the thumb hash.
- 2026-09-30 · Only mcp__deck__* is pre-approved in allowedTools. The SDK auto-approves any bare allowedTools entry before canUseTool runs (warning CLAUDE_SDK_CAN_USE_TOOL_SHADOWED seen in the e2e run), so Read/Bash/Write all fall through to canUseTool, which allows reads and denies writes under the deck folder.
- 2026-09-30 · Image generation calls ~/.claude/scripts/generate_image.py (override DECKSTUDIO_IMAGE_SCRIPT) with the shared keynote-flat-diagram style prefix, then scripts/img/paperize3.py and trim.py. No script, no image: the tool returns an error to the model instead of a placeholder.
- 2026-09-30 · Lanes created by checks are persisted with status 'draft' and stay off the main screen until the creator opens them (from the remark or the brief). A check may open at most 3 draft lanes per run. Reason: the M4 persona hit a wall of unsolicited lanes after one run of the four checks.
- 2026-09-30 · open-as-lane anchors each placement on its predecessor in the target version. When two placed slides are adjacent in the target, the result depends on the accept order (a chained move accepted early lands in the wrong place without error). Kept as a known v1 limitation (documented in changesToward): the fix needs accept-time re-resolution or an absolute-index anchor in the Change contract.
