import { describe, expect, it } from 'vitest';
import { assembleSlideHtml, sanitizeBody } from '../../src/render/theme.js';
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

describe('sanitizeBody', () => {
  it('does not reassemble a script from a split-tag payload', () => {
    const out = sanitizeBody('<scr</script>ipt>alert(1)</scr</script>ipt>');
    expect(out).not.toMatch(/<script/i);
  });

  it('drops event handlers, including slash-separated ones', () => {
    expect(sanitizeBody('<img src=x onerror=alert(1)>')).not.toMatch(/onerror/i);
    expect(sanitizeBody('<svg/onload=alert(1)>')).not.toMatch(/onload/i);
    expect(sanitizeBody('<img src=x/onerror=alert(1)>')).not.toMatch(/\sonerror\s*=/i);
  });

  it('drops javascript: hrefs', () => {
    const out = sanitizeBody('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/href=/i);
    expect(out).toContain('x');
  });

  it('removes iframes with srcdoc, object, embed, base, meta, link and form', () => {
    const out = sanitizeBody(
      '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="x"></object><embed src="y"><base href="//evil"><meta http-equiv="refresh" content="0;url=//evil"><link rel="stylesheet" href="//evil"><form action="//evil"><input></form><p>kept</p>',
    );
    for (const tag of ['iframe', 'srcdoc', 'object', 'embed', 'base', 'meta', 'link', 'form']) expect(out).not.toMatch(new RegExp(tag, 'i'));
    expect(out).toContain('<p>kept</p>');
  });

  it('balances unclosed markup', () => {
    expect(sanitizeBody('<div><b>x')).toBe('<div><b>x</b></div>');
    expect(sanitizeBody('</section></div><p>y</p>')).toBe('<p>y</p>');
  });

  it('keeps svg text with its positioning attributes', () => {
    const out = sanitizeBody('<svg viewBox="0 0 100 50" width="100"><text x="10" y="20" font-size="14" fill="#E4572E">label</text><path d="M0 0 L10 10" stroke="#000"/></svg>');
    expect(out).toContain('<svg');
    expect(out).toMatch(/<text[^>]*\sx="10"/);
    expect(out).toMatch(/<text[^>]*\sy="20"/);
    expect(out).toMatch(/<text[^>]*\sfont-size="14"/);
    expect(out).toContain('label</text>');
    expect(out).toMatch(/<path[^>]*d="M0 0 L10 10"/);
  });

  it('keeps inline styles, classes and data-kind', () => {
    const out = sanitizeBody('<div class="k" data-kind="stat" style="position:absolute;left:96px;color:#E4572E">ok</div>');
    expect(out).toContain('style="position:absolute;left:96px;color:#E4572E"');
    expect(out).toContain('class="k"');
    expect(out).toContain('data-kind="stat"');
  });
});
