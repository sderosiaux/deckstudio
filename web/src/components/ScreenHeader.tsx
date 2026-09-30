import type { ReactNode } from 'react';
import { navigate as defaultNavigate } from '../api.js';

/**
 * The header every screen shares: the 120px gutter, then the screen's title on the column start, on one baseline, so
 * the title never moves between screens. Away from main the gutter holds the way back ("main"); on main it stays
 * empty, since the filmstrip's own row label already names main.
 */
export function ScreenHeader({ onMain = false, navigate = defaultNavigate, children }: { onMain?: boolean; navigate?: (path: string) => void; children: ReactNode }) {
  return (
    <header className="screen-header">
      <div className="gutter">
        {onMain ? null : (
          <a
            href="/"
            data-testid="header-main"
            className="link"
            onClick={(e) => {
              e.preventDefault();
              navigate('/');
            }}
          >
            main
          </a>
        )}
      </div>
      {children}
    </header>
  );
}
