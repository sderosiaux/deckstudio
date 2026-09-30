import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Slide } from '../model/types.js';

/** Self-hosted Archivo + IBM Plex Mono (same faces as the original deck), so renders never hit the network. */
export const FONTS_DIR = fileURLToPath(new URL('./fonts/', import.meta.url));
const FONTS_CSS = readFileSync(`${FONTS_DIR}fonts.css`, 'utf8').trim();
export const DEFAULT_FONTS_BASE_URL = '/fonts';

/** Inline <style> with the @font-face rules, their src() pointing at fontsBaseUrl. */
export function fontsStyle(fontsBaseUrl: string = DEFAULT_FONTS_BASE_URL): string {
  const base = trimSlash(fontsBaseUrl);
  return `<style data-fonts>${FONTS_CSS.replaceAll('FONT_BASE', base)}</style>`;
}
export const STAGE_WIDTH = 1280;
export const STAGE_HEIGHT = 720;

// The deck theme positions .slide centered and scaled inside a full-window #viewport.
// For rendering we pin the stage at the origin at scale 1 so a 1280x720 clip is exactly one slide.
const STAGE_OVERRIDE = `
html,body{margin:0;padding:0;width:${STAGE_WIDTH}px;height:${STAGE_HEIGHT}px;overflow:hidden}
#viewport{position:relative !important;inset:auto !important;width:${STAGE_WIDTH}px !important;height:${STAGE_HEIGHT}px !important;overflow:hidden !important;display:block !important}
#viewport>.slide{position:absolute !important;left:0 !important;top:0 !important;transform:none !important;display:block !important;width:${STAGE_WIDTH}px !important;height:${STAGE_HEIGHT}px !important}
`;

const STRATA = '<div class="strata thin"><i></i><i></i><i></i></div>';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Removes script elements (closed or not) and inline event-handler attributes. */
export function sanitizeBody(body: string): string {
  return body
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[\s\S]*$/gi, '')
    .replace(/<\/script\s*>/gi, '')
    .replace(/(<[a-zA-Z][^\s/>]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)(\s*\/?>)/g, (_m, open: string, attrs: string, close: string) => {
      const kept = attrs.replace(/\s+on[a-z0-9_-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/gi, '');
      return `${open}${kept}${close}`;
    });
}

/** Rewrites relative `assets/...` references (src attributes and CSS url()) to the given base URL. */
export function rewriteAssetUrls(body: string, assetsBaseUrl: string): string {
  const base = trimSlash(assetsBaseUrl);
  return body
    .replace(/(\ssrc\s*=\s*)(["']?)(?:\.\/)?assets\//gi, (_m, pre: string, q: string) => `${pre}${q}${base}/`)
    .replace(/url\(\s*(["']?)(?:\.\/)?assets\//gi, (_m, q: string) => `url(${q}${base}/`);
}

export function assembleSlideHtml(
  slide: Pick<Slide, 'title' | 'body' | 'kind'>,
  opts: { themeCss: string; assetsBaseUrl: string; fontsBaseUrl?: string },
): string {
  const body = rewriteAssetUrls(sanitizeBody(slide.body), opts.assetsBaseUrl);
  const strata = /class\s*=\s*["'][^"']*\bstrata\b/.test(body) ? '' : STRATA;
  const title = `<h2 style="position:absolute;left:96px;top:72px">${escapeHtml(slide.title)}</h2>`;
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="UTF-8">',
    fontsStyle(opts.fontsBaseUrl),
    `<style>${opts.themeCss}</style>`,
    `<style>${STAGE_OVERRIDE}</style>`,
    '</head><body>',
    `<div id="viewport" style="position:relative;width:${STAGE_WIDTH}px;height:${STAGE_HEIGHT}px">`,
    `<section class="slide active" data-kind="${escapeHtml(slide.kind)}">`,
    title,
    body,
    strata,
    '</section>',
    '</div>',
    '</body></html>',
  ].join('\n');
}
