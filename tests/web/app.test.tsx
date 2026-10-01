// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { waitFor } from '../helpers/waitFor.js';

const m = vi.hoisted(() => ({ getDeckSummary: vi.fn() }));

vi.mock('../../web/src/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../web/src/api.js')>();
  return { ...real, getDeckSummary: m.getDeckSummary };
});
// The screens themselves have their own tests: here only which one the URL picks, and under which deck.
vi.mock('../../web/src/screens/Home.js', () => ({ Home: () => <p data-testid="screen">home</p> }));
vi.mock('../../web/src/screens/Main.js', () => ({ Main: () => <p data-testid="screen">main {location.pathname}</p> }));
vi.mock('../../web/src/screens/History.js', () => ({ History: () => <p data-testid="screen">history</p> }));
vi.mock('../../web/src/screens/BriefChecks.js', () => ({ BriefChecks: () => <p data-testid="screen">brief</p> }));
vi.mock('../../web/src/screens/Slide.js', () => ({ Slide: ({ slideId }: { slideId: string }) => <p data-testid="screen">slide {slideId}</p> }));
vi.mock('../../web/src/screens/Focus.js', () => ({ Focus: ({ laneId, changeId }: { laneId: string; changeId: string }) => <p data-testid="screen">focus {laneId} {changeId}</p> }));
vi.mock('../../web/src/screens/Present.js', () => ({ Present: () => <p data-testid="screen">present</p> }));

const { App } = await import('../../web/src/App.js');
const { ApiError, navigate } = await import('../../web/src/api.js');

const at = (path: string): void => history.replaceState(null, '', path);
const shown = (): string | null => screen.queryByTestId('screen')?.textContent ?? null;
const summary = (id: string) => ({ id, title: id, slides: 0, version: 0, updatedAt: '2026-09-30T00:00:00.000Z', coverSlideId: null });

beforeEach(() => {
  m.getDeckSummary.mockReset().mockImplementation(async (id: string) => {
    if (id === 'x' || id === 'y') return summary(id);
    throw new ApiError('GET', `/api/decks/${id}`, 404, `unknown deck "${id}"`);
  });
});
afterEach(() => {
  cleanup();
  at('/');
});

describe('App routing', () => {
  it('shows the home screen at /', () => {
    at('/');
    render(<App />);
    expect(shown()).toBe('home');
  });

  it('routes a deck screen under /d/<id>/, once the deck is known', async () => {
    at('/d/x/history');
    render(<App />);
    await waitFor(() => shown() === 'history');
    expect(m.getDeckSummary).toHaveBeenCalledWith('x');
  });

  it('routes main, slide, focus, brief and present under the deck base', async () => {
    const cases: Array<[string, string]> = [
      ['/d/x/', 'main /d/x/'],
      ['/d/x', 'main /d/x'],
      ['/d/x/slide/s%202', 'slide s 2'],
      ['/d/x/lane/l1/change/c1', 'focus l1 c1'],
      ['/d/x/brief', 'brief'],
      ['/d/x/present', 'present'],
    ];
    for (const [path, expected] of cases) {
      at(path);
      render(<App />);
      await waitFor(() => shown() === expected);
      cleanup();
    }
  });

  it('says so, with a link home, for a deck the studio does not have', async () => {
    at('/d/nope/history');
    render(<App />);
    await screen.findByText(/No deck named “nope”/);
    expect(shown()).toBeNull();
    const home = screen.getByRole('link', { name: 'all decks' });
    expect(home.getAttribute('href')).toBe('/');
    fireEvent.click(home);
    await waitFor(() => shown() === 'home');
    expect(location.pathname).toBe('/');
  });

  it('follows navigate from home into a deck and from one deck to another', async () => {
    at('/');
    render(<App />);
    act(() => navigate('/d/x/'));
    await waitFor(() => shown() === 'main /d/x/');
    act(() => navigate('/d/y/brief'));
    await waitFor(() => shown() === 'brief');
    expect(m.getDeckSummary).toHaveBeenCalledWith('y');
  });
});
