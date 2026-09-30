import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Slide } from '../../model/types.js';
import { assembleSlideHtml, FONTS_LINK } from '../../render/theme.js';
import type { DeckStore } from '../../store/deckStore.js';

const ASSETS_BASE_URL = '/assets';
const SECTION_OPEN = '<section class="slide active"';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** JSON safe to inline in a <script> element. */
function inlineJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The <section> of one slide, taken from the stage document so present mode and thumbs share one assembly. */
function slideSection(slide: Slide): string {
  const doc = assembleSlideHtml(slide, { themeCss: '', assetsBaseUrl: ASSETS_BASE_URL });
  const start = doc.indexOf(SECTION_OPEN);
  const end = doc.lastIndexOf('</section>');
  if (start < 0 || end < start) throw new Error(`assembleSlideHtml produced no slide section for ${slide.id}`);
  return `<section class="slide" data-id="${escapeHtml(slide.id)}"${doc.slice(start + SECTION_OPEN.length, end)}</section>`;
}

// Same behaviour as the original deck.html player: #n hash navigation, arrows/space/PageUp/PageDown,
// Home/End, click halves, "s" story panel, "n" notes to console, "h" hud, strata lines drawn as SVG.
const PLAYER = `
(function(){
  const slides=[...document.querySelectorAll('#viewport>.slide')];
  const meta=JSON.parse(document.getElementById('deck-meta').textContent);
  const hud=document.getElementById('hud');
  const story=document.getElementById('story'),btn=document.getElementById('story-btn');
  if(!slides.length){hud.textContent='empty deck';return;}
  let i=Math.max(1,Math.min(slides.length,parseInt(location.hash.slice(1))||1))-1;
  function fit(){const s=Math.min(innerWidth/1280,innerHeight/720);document.documentElement.style.setProperty('--s',s);}
  function esc(t){return t.replace(/&/g,'&amp;').replace(/</g,'&lt;');}
  function show(n){i=(n+slides.length)%slides.length;slides.forEach((s,k)=>s.classList.toggle('active',k===i));history.replaceState(null,'','#'+(i+1));hud.textContent=(i+1)+' / '+slides.length;const t=(meta[i].story||meta[i].notes||'').trim();story.innerHTML='<b>'+(i+1)+' / '+slides.length+' · the story</b> '+esc(t);}
  btn.addEventListener('click',e=>{e.stopPropagation();document.body.classList.toggle('story');});
  story.addEventListener('click',e=>e.stopPropagation());
  addEventListener('resize',fit);fit();show(i);
  addEventListener('keydown',e=>{if(['ArrowRight',' ','PageDown'].includes(e.key)){e.preventDefault();show(i+1);}else if(['ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();show(i-1);}else if(e.key==='Home'){show(0);}else if(e.key==='End'){show(slides.length-1);}else if(e.key==='n'){console.log(meta[i].notes);}else if(e.key==='h'){document.body.classList.toggle('hud');}else if(e.key==='s'){document.body.classList.toggle('story');}});
  addEventListener('hashchange',()=>show((parseInt(location.hash.slice(1))||1)-1));
  addEventListener('click',e=>{if(e.clientX>innerWidth/2)show(i+1);else show(i-1);});
})();
document.querySelectorAll('.strata').forEach(el=>{const thin=el.classList.contains('thin');const h=thin?56:113;const n=6;const amp=thin?3:4;const gap=h/n;let svg='<svg width="1280" height="'+h+'" viewBox="0 0 1280 '+h+'" aria-hidden="true">';for(let i=0;i<n;i++){const y=gap/2+i*gap;let d='M0 '+y.toFixed(1);for(let x=20;x<=1280;x+=20){d+=' L'+x+' '+(y+amp*Math.sin(x/1280*Math.PI*3)).toFixed(1)}svg+='<path d="'+d+'" fill="none" stroke="'+(i===2?'#E4572E':'#D9D6CF')+'" stroke-width="2"/>'}svg+='</svg>';el.innerHTML=svg;el.style.height=h+'px'});
`;

export function presentRoutes(app: FastifyInstance, store: DeckStore): void {
  app.get('/api/present', async (_req, reply) => {
    const [themeCss, state, { order, slides }] = await Promise.all([
      readFile(join(store.dir, 'theme.css'), 'utf8'),
      store.state(),
      store.snapshot(),
    ]);
    const main = order.map((id) => slides[id]!);
    const meta = main.map((s) => ({ id: s.id, title: s.title, story: s.story, notes: s.notes }));
    const html = [
      '<!DOCTYPE html>',
      '<html lang="en"><head><meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `<title>${escapeHtml(state.name)}</title>`,
      FONTS_LINK,
      `<style>${themeCss}</style>`,
      '</head><body>',
      '<div id="viewport">',
      '<button id="story-btn" title="story (s)">?</button>',
      '<div id="story"></div>',
      ...main.map(slideSection),
      '</div>',
      '<div id="hud"></div>',
      `<script type="application/json" id="deck-meta">${inlineJson(meta)}</script>`,
      `<script>${PLAYER}</script>`,
      '</body></html>',
    ].join('\n');
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
