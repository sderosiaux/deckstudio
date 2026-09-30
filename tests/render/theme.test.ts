import { describe, expect, it } from 'vitest';
import { assembleSlideHtml } from '../../src/render/theme.js';
import { themeCss } from './themeCss.js';

const opts = { themeCss, assetsBaseUrl: 'http://deck.local/assets' };

describe('assembleSlideHtml', () => {
  it('strips scripts and event handlers, keeps images, rewrites asset src', () => {
    const html = assembleSlideHtml(
      {
        title: 'One log, everything derived',
        kind: 'diagram',
        body: '<script>document.title="pwned"</script><img src="assets/s02.png" onerror="alert(1)" alt=""><SCRIPT type="module">x()</SCRIPT><div onclick=\'y()\' class="k">ok</div><script src="evil.js">',
      },
      opts,
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('pwned');
    expect(html).not.toMatch(/\son\w+\s*=/i);
    expect(html).toContain('<img src="http://deck.local/assets/s02.png"');
    expect(html).not.toContain('src="assets/');
    expect(html).toContain('<div class="k">ok</div>');
    expect(html.split('One log, everything derived').length - 1).toBe(1);
  });

  it('is a full document with the theme, a 1280x720 active slide and the positioned title', () => {
    const html = assembleSlideHtml({ title: 'A & <B>', kind: 'text', body: '<p>x</p>' }, opts);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain(themeCss);
    expect(html).toContain('<section class="slide active" data-kind="text">');
    expect(html).toContain('<h2 style="position:absolute;left:96px;top:72px">A &amp; &lt;B&gt;</h2>');
    expect(html).toContain('width:1280px;height:720px');
    expect(html).toContain('class="strata thin"');
  });

  it('does not add a second strata when the body already has one', () => {
    const html = assembleSlideHtml(
      { title: 't', kind: 'text', body: '<p>x</p><div class="strata thin"><i></i><i></i><i></i></div>' },
      opts,
    );
    expect(html.split('class="strata').length - 1).toBe(1);
  });

  it('rewrites asset urls in inline styles and leaves absolute urls alone', () => {
    const html = assembleSlideHtml(
      { title: 't', kind: 'text', body: '<div style="background:url(assets/bg.png)"></div><img src="https://x.test/a.png">' },
      opts,
    );
    expect(html).toContain('url(http://deck.local/assets/bg.png)');
    expect(html).toContain('<img src="https://x.test/a.png">');
  });
});
