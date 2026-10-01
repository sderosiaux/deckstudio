// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ApiError, type DeckSummary, type HomeApi } from '../../web/src/api.js';
import { Home, updatedLabel } from '../../web/src/screens/Home.js';
import { waitFor } from '../helpers/waitFor.js';

const deck = (over: Partial<DeckSummary>): DeckSummary => ({
  id: 'd',
  title: 'Deck',
  slides: 3,
  version: 2,
  updatedAt: '2026-09-30T10:00:00.000Z',
  coverSlideId: 's1',
  ...over,
});

const stubApi = (decks: DeckSummary[]) => ({
  listDecks: vi.fn<HomeApi['listDecks']>(async () => decks),
  createDeck: vi.fn<HomeApi['createDeck']>(async (input) => deck({ id: 'onboarding', title: input.title, slides: 0, version: 0, coverSlideId: null })),
  importDeck: vi.fn<HomeApi['importDeck']>(async () => deck({ id: 'imported', title: 'Imported' })),
  deckThumbFor: vi.fn<HomeApi['deckThumbFor']>(async (id, slideId) => ({ hash: `h_${id}_${slideId}`, ready: true })),
});

const NOW = new Date('2026-09-30T12:00:00.000Z');
let navigate: ReturnType<typeof vi.fn<(path: string) => void>>;
beforeEach(() => {
  navigate = vi.fn<(path: string) => void>();
});
afterEach(() => cleanup());

const type = (label: RegExp | string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

describe('Home', () => {
  it('lists every deck as a card: cover, title, slides and version, last change; a click opens the deck', async () => {
    const api = stubApi([
      deck({ id: 'sf', title: 'Kafka at scale', slides: 22, version: 14, updatedAt: '2026-09-30T11:00:00.000Z', coverSlideId: 's1' }),
      deck({ id: 'empty', title: 'Fresh talk', slides: 0, version: 0, coverSlideId: null }),
    ]);
    render(<Home api={api} navigate={navigate} now={() => NOW} />);
    await waitFor(() => screen.queryAllByTestId('deck-card').length === 2);
    const [sf, empty] = screen.getAllByTestId('deck-card') as [HTMLElement, HTMLElement];
    expect(within(sf).getByText('Kafka at scale')).toBeTruthy();
    expect(within(sf).getByText('22 slides, v14')).toBeTruthy();
    expect(within(sf).getByText('updated 1 hour ago')).toBeTruthy();
    expect(sf.getAttribute('href')).toBe('/d/sf/');
    await waitFor(() => within(sf).queryByTestId('cover-image'));
    expect(within(sf).getByTestId('cover-image').getAttribute('src')).toBe('/d/sf/api/thumbs/h_sf_s1.png');
    expect(api.deckThumbFor).toHaveBeenCalledWith('sf', 's1');
    // An empty deck has no cover slide: the grey placeholder, and no thumbnail request.
    expect(within(empty).getByTestId('thumb-placeholder')).toBeTruthy();
    expect(within(empty).getByText('0 slides, v0')).toBeTruthy();
    expect(api.deckThumbFor).not.toHaveBeenCalledWith('empty', expect.anything());
    // No middle dot anywhere in the meta.
    expect(document.body.textContent).not.toContain('·');
    fireEvent.click(sf);
    expect(navigate).toHaveBeenCalledWith('/d/sf/');
  });

  it('guides an empty studio to create or import', async () => {
    render(<Home api={stubApi([])} navigate={navigate} now={() => NOW} />);
    await screen.findByText('No presentations yet. Create one or import a deck.html.');
    expect(screen.queryAllByTestId('deck-card')).toHaveLength(0);
  });

  it('creates a presentation from the inline form and opens it', async () => {
    const api = stubApi([]);
    render(<Home api={api} navigate={navigate} now={() => NOW} />);
    await screen.findByText(/No presentations yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New presentation' }));
    expect(document.activeElement).toBe(screen.getByLabelText('title'));
    type('title', 'Onboarding engineers in a week');
    type('audience', 'Engineering managers');
    type(/message/, 'A new engineer ships on day five.');
    fireEvent.click(screen.getByLabelText('problem by problem, build up'));
    expect(screen.getByText('leave empty for the starter rules')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => navigate.mock.calls.length === 1);
    expect(api.createDeck).toHaveBeenCalledWith({
      title: 'Onboarding engineers in a week',
      audience: 'Engineering managers',
      message: 'A new engineer ships on day five.',
      pattern: 'problem-driven',
    });
    expect(navigate).toHaveBeenCalledWith('/d/onboarding/');
  });

  it('sends the abstract and design rules only when written', async () => {
    const api = stubApi([]);
    render(<Home api={api} navigate={navigate} now={() => NOW} />);
    await screen.findByText(/No presentations yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New presentation' }));
    type('title', 'T');
    type(/abstract/, 'An abstract.');
    type(/design rules/, 'One idea per slide.');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => navigate.mock.calls.length === 1);
    expect(api.createDeck).toHaveBeenCalledWith({ title: 'T', audience: '', message: '', pattern: 'solution-first', abstract: 'An abstract.', design: { rules: 'One idea per slide.' } });
  });

  it('keeps the form and says so when the id is taken (409)', async () => {
    const api = stubApi([]);
    api.createDeck.mockRejectedValueOnce(new ApiError('POST', '/api/decks', 409, 'a deck named "t" already exists'));
    render(<Home api={api} navigate={navigate} now={() => NOW} />);
    await screen.findByText(/No presentations yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New presentation' }));
    type('title', 'T');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/a deck with this id exists/i);
    expect(navigate).not.toHaveBeenCalled();
    expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('T');
  });

  it('does not send a form without a title', async () => {
    const api = stubApi([]);
    render(<Home api={api} navigate={navigate} now={() => NOW} />);
    await screen.findByText(/No presentations yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New presentation' }));
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.createDeck).not.toHaveBeenCalled();
  });

  it('imports a deck.html by path and opens it; an import error shows inline', async () => {
    const api = stubApi([]);
    api.importDeck.mockRejectedValueOnce(new ApiError('POST', '/api/decks/import', 400, 'no file at /nope.html'));
    render(<Home api={api} navigate={navigate} now={() => NOW} />);
    await screen.findByText(/No presentations yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Import a deck.html' }));
    type(/path/, '/nope.html');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('alert')).textContent).toContain('no file at /nope.html');
    type(/path/, '/talks/deck.html');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => navigate.mock.calls.length === 1);
    expect(api.importDeck).toHaveBeenLastCalledWith('/talks/deck.html');
    expect(navigate).toHaveBeenCalledWith('/d/imported/');
  });

  it('shows a load error with a retry', async () => {
    const api = stubApi([]);
    api.listDecks.mockRejectedValueOnce(new Error('offline'));
    render(<Home api={api} navigate={navigate} now={() => NOW} />);
    await screen.findByText(/offline/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/No presentations yet/);
  });
});

describe('updatedLabel', () => {
  it('words the last change relative to now', () => {
    expect(updatedLabel('2026-09-30T11:59:40.000Z', NOW)).toBe('updated just now');
    expect(updatedLabel('2026-09-30T11:55:00.000Z', NOW)).toBe('updated 5 minutes ago');
    expect(updatedLabel('2026-09-30T11:00:00.000Z', NOW)).toBe('updated 1 hour ago');
    expect(updatedLabel('2026-09-29T09:00:00.000Z', NOW)).toBe('updated yesterday');
    expect(updatedLabel('2026-09-25T12:00:00.000Z', NOW)).toBe('updated 5 days ago');
    expect(updatedLabel('2026-03-01T12:00:00.000Z', NOW)).toMatch(/^updated on /);
  });
});
