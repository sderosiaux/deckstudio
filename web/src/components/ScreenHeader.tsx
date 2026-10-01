import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { HOME_PATH, mainHref, navigate as defaultNavigate } from '../api.js';

/**
 * The header every screen shares: the empty 120px gutter, then the screen's title on the column start (x = 144), on
 * one baseline, so the title never moves between screens and no screen names itself twice.
 */
export function ScreenHeader({ children }: { children: ReactNode }) {
  return (
    <header className="screen-header">
      <div className="gutter" />
      {children}
    </header>
  );
}

const follow = (path: string, navigate: (path: string) => void) => (e: MouseEvent<HTMLAnchorElement>) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(path);
};

/** The way out to every deck of the studio (the home screen), a quiet link; `style` places it in the header. */
export function DecksLink({ navigate = defaultNavigate, style }: { navigate?: (path: string) => void; style?: CSSProperties }) {
  return (
    <a href={HOME_PATH} data-testid="header-decks" className="link" style={style} onClick={follow(HOME_PATH, navigate)}>
      decks
    </a>
  );
}

/** The ways back, quiet links on the header's right side before the screen's primary action: every deck, then main. */
export function BackToMain({ navigate = defaultNavigate, style }: { navigate?: (path: string) => void; style?: CSSProperties }) {
  const main = mainHref();
  return (
    <>
      <DecksLink navigate={navigate} style={{ marginLeft: 'auto', ...style }} />
      <a href={main} data-testid="header-main" className="link" style={style} onClick={follow(main, navigate)}>
        back to main
      </a>
    </>
  );
}
