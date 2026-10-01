// @vitest-environment jsdom
/**
 * Main's layout measured in a real browser: jsdom lays nothing out, so the markup Main renders here (inline styles and
 * classes as React wrote them) is loaded with theme.css into Chromium at 1440x900 and measured there.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { DeckPayload } from '../../web/src/api.js';
import type { Slide, SlideId } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

const m = vi.hoisted(() => ({ deck: null as unknown }));

const slide = (id: string): Slide => ({ id, title: `Title ${id}`, story: '', notes: '', body: `<p>${id}</p>`, assets: [], kind: 'text' });
const deckOf = (n: number): DeckPayload => {
  const order: SlideId[] = Array.from({ length: n }, (_, i) => `s${i + 1}`);
  return {
    state: { name: 'd', order, version: 3, sessionId: null, model: 'm' },
    brief: { title: 'Deck', audience: '', message: '', pattern: 'problem-driven', abstract: '', design: { rules: '', imageStyle: '' } },
    order,
    slides: Object.fromEntries(order.map((id) => [id, slide(id)])),
  };
};

vi.mock('../../web/src/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../web/src/api.js')>();
  return {
    ...real,
    getDeck: async () => m.deck,
    getVersions: async () => [],
    getLanes: async () => [],
    getLane: vi.fn(),
    getLanePreview: vi.fn(),
    thumbFor: async (id: SlideId) => ({ hash: `h_${id}`, ready: true }),
    getRemarks: async () => [],
    openLane: vi.fn(),
    openPlayer: vi.fn(),
    remarkApi: { proposeRemark: vi.fn(), resolveRemark: vi.fn() },
    threadApi: { getThread: async () => [], postMessage: vi.fn() },
    laneApi: { acceptChange: vi.fn(), refuseChange: vi.fn(), discardLane: vi.fn() },
    subscribe: () => () => undefined,
  };
});

const { Main } = await import('../../web/src/screens/Main.js');

const css = readFileSync(join(process.cwd(), 'web/src/theme.css'), 'utf8');
let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
});
afterAll(async () => {
  await browser?.close();
});
afterEach(() => cleanup());

/** What Main rendered, as a page of its own in Chromium. */
const load = async (container: HTMLElement): Promise<void> => {
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div id="root">${container.innerHTML}</div></body></html>`);
};
const thumb = (id: SlideId): HTMLElement => screen.getAllByTestId('thumb').find((t) => t.closest('[data-strip="main"]') && t.getAttribute('data-slide') === id)!;

describe('Main layout in a browser', () => {
  it('a range stage stays pinned to the canvas visible left while the strip scrolls to its end, never cut', async () => {
    m.deck = deckOf(30);
    const { container } = render(<Main />);
    await waitFor(() => screen.queryAllByTestId('thumb').length >= 30);
    fireEvent.click(thumb('s4'));
    fireEvent.click(thumb('s6'), { shiftKey: true });
    await waitFor(() => screen.queryByTestId('selection-stage'));
    await load(container);
    const at = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>('[data-testid="canvas"]')!;
      const stage = document.querySelector<HTMLElement>('[data-testid="selection-stage"]')!;
      const pad = parseFloat(getComputedStyle(canvas).paddingLeft);
      const box = canvas.getBoundingClientRect();
      const start = stage.getBoundingClientRect();
      canvas.scrollLeft = canvas.scrollWidth;
      const end = stage.getBoundingClientRect();
      return { scrolled: canvas.scrollLeft, max: canvas.scrollWidth - canvas.clientWidth, visibleLeft: box.left + pad, right: box.right, start: start.left, endLeft: end.left, endRight: end.right };
    });
    expect(at.scrolled).toBeGreaterThan(0);
    expect(at.scrolled).toBe(at.max);
    // Within a subpixel: the scroll end is a fractional width.
    expect(at.start).toBeCloseTo(at.visibleLeft, 0);
    expect(at.endLeft).toBeCloseTo(at.visibleLeft, 0);
    expect(at.endRight).toBeLessThanOrEqual(at.right);
  }, 60_000);

  it('the deck sheet is pinned the same way', async () => {
    m.deck = deckOf(30);
    const { container } = render(<Main />);
    await waitFor(() => screen.queryByTestId('deck-sheet'));
    await load(container);
    const at = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>('[data-testid="canvas"]')!;
      const sheet = document.querySelector<HTMLElement>('[data-testid="deck-sheet"]')!;
      const visibleLeft = canvas.getBoundingClientRect().left + parseFloat(getComputedStyle(canvas).paddingLeft);
      canvas.scrollLeft = canvas.scrollWidth;
      return { scrolled: canvas.scrollLeft, visibleLeft, left: sheet.getBoundingClientRect().left };
    });
    expect(at.scrolled).toBeGreaterThan(0);
    expect(at.left).toBeCloseTo(at.visibleLeft, 0);
  }, 60_000);

  it('an empty deck says "No slides yet" on the title column, not in the gutter', async () => {
    m.deck = deckOf(0);
    const { container } = render(<Main />);
    await waitFor(() => screen.queryByTestId('no-slides'));
    await load(container);
    const x = await page.evaluate(() => ({
      title: document.querySelector('h1.screen-title')!.getBoundingClientRect().left,
      empty: document.querySelector('[data-testid="no-slides"]')!.getBoundingClientRect().left,
    }));
    expect(x.title).toBe(144);
    expect(x.empty).toBe(x.title);
  }, 60_000);
});
