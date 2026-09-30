import { Main } from './screens/Main.js';
import { Present } from './screens/Present.js';

/** No router: the path picks the screen. */
export function App() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/present') return <Present />;
  return <Main />;
}
