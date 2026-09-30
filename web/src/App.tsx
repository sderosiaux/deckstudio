import { useEffect, useState } from 'react';
import { BRIEF_PATH, HISTORY_PATH } from './api.js';
import { BriefChecks } from './screens/BriefChecks.js';
import { Focus } from './screens/Focus.js';
import { History } from './screens/History.js';
import { Main } from './screens/Main.js';
import { Present } from './screens/Present.js';

const currentPath = (): string => location.pathname.replace(/\/+$/, '') || '/';
const FOCUS = /^\/lane\/([^/]+)\/change\/([^/]+)$/;

/** No router library: the path picks the screen, and `navigate` (api.ts) re-renders through popstate. */
export function App() {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onPop = (): void => setPath(currentPath());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  if (path === '/present') return <Present />;
  if (path === BRIEF_PATH) return <BriefChecks />;
  if (path === HISTORY_PATH) return <History />;
  const focus = FOCUS.exec(path);
  if (focus) {
    const laneId = decodeURIComponent(focus[1]!);
    return <Focus key={laneId} laneId={laneId} changeId={decodeURIComponent(focus[2]!)} />;
  }
  return <Main />;
}
