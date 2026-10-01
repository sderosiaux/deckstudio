import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The deck theme used when a deck folder has no theme.css (decks made with DeckStore.init alone). */
export const DEFAULT_THEME_CSS = String.raw`
:root{--paper:#FAF9F6;--ink:#17171A;--accent:#E4572E;--grey:#7A7873;--grey-2:#8C8983;--line:#D9D6CF;--card:#FFFFFF;--display:'Archivo',system-ui,sans-serif;--mono:'IBM Plex Mono',ui-monospace,monospace}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#E9E7E1;overflow:hidden;font-family:var(--display);color:var(--ink)}
#viewport{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
.slide{width:1280px;height:720px;background:var(--paper);position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(var(--s,1));transform-origin:center;display:none;overflow:hidden;padding:72px 96px}
.slide.active{display:block}
.notes{display:none}
.eyebrow{font-size:28px;letter-spacing:.14em;text-transform:uppercase;color:var(--grey);font-weight:500}
h1{font-size:96px;line-height:.98;letter-spacing:-.03em;font-weight:800}
h2{font-size:82px;line-height:1;letter-spacing:-.03em;font-weight:800}
.big{font-size:64px;line-height:1.12;letter-spacing:-.02em;font-weight:700}
.cap{font-size:32px;line-height:1.3;color:var(--grey)}
.content{position:absolute;left:96px;right:96px;top:186px;bottom:96px;display:flex;flex-direction:column;justify-content:center;gap:28px}
.acc{color:var(--accent)}
.grey{color:var(--grey)}
.strata{position:absolute;left:0;right:0;height:120px;pointer-events:none}
.strata i{display:block;height:2px;background:var(--line);margin:0 0 22px}
.strata i.a{background:var(--accent)}
.strata.thin{height:60px;top:664px}
.strata.thin i{margin:0 0 14px}
svg text{font-family:var(--display)}
svg .m{font-family:var(--mono)}
.mono{position:absolute;background:var(--card);border:0;border-left:5px solid var(--ink);border-radius:10px;box-shadow:0 4px 12px rgba(23,23,26,.10);padding:16px 22px;font:28px/1.35 var(--mono);color:var(--ink);white-space:pre}
.code{position:absolute;left:96px;top:186px;width:1088px;background:var(--card);border-radius:12px;box-shadow:0 6px 18px rgba(23,23,26,.10);padding:16px 26px 14px;font:18px/1.3 var(--mono);color:var(--ink);white-space:pre;overflow:hidden}
.code .kw{font-weight:700}.code .st{color:var(--accent)}.code .cm{color:var(--grey)}
.code .src{position:absolute;right:20px;bottom:10px;font-size:17px;color:var(--grey)}
#story-btn{position:fixed;right:24px;top:22px;width:44px;height:44px;border-radius:22px;border:2px solid var(--line);background:var(--card);color:var(--grey);font:700 22px var(--display);cursor:pointer;z-index:5;display:flex;align-items:center;justify-content:center}
#story-btn:hover{border-color:var(--ink);color:var(--ink)}
body.story #story-btn{background:var(--accent);border-color:var(--accent);color:#fff}
#story{position:fixed;right:24px;top:76px;width:480px;max-height:70vh;overflow:auto;background:var(--card);border-radius:12px;box-shadow:0 8px 24px rgba(23,23,26,.16);padding:22px 26px;font:24px/1.4 var(--display);color:var(--ink);z-index:5;display:none;white-space:normal}
body.story #story{display:block}
#story b{display:block;font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:8px}
#hud{position:fixed;right:18px;bottom:12px;font:14px var(--mono);color:#8A8A8A;user-select:none;display:none}
body.hud #hud{display:block}
`;

export async function loadThemeCss(deckDir: string): Promise<string> {
  try {
    return await readFile(join(deckDir, 'theme.css'), 'utf8');
  } catch {
    return DEFAULT_THEME_CSS;
  }
}
