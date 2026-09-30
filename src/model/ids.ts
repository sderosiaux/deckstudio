import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Slide } from './types.js';

export function newId(prefix: string): string {
  return `${prefix}${nanoid(10)}`;
}

/** Content hash of a slide. Key order is fixed so the hash is stable; the id is excluded on purpose. */
export function hashSlide(slide: Slide): string {
  const { title, story, notes, body, assets, kind } = slide;
  return createHash('sha256').update(JSON.stringify({ title, story, notes, body, assets, kind })).digest('hex');
}
