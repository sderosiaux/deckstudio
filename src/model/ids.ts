import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Slide } from './types.js';

export function newId(prefix: 's' | 'l' | 'c' | 'r' | 'm'): string {
  return `${prefix}_${nanoid(10)}`;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k] as Json)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Content hash of a slide. The id is excluded: two slides with the same content share an object on disk. */
export function hashSlide(s: Slide): string {
  const content: Json = { title: s.title, story: s.story, notes: s.notes, body: s.body, assets: [...s.assets], kind: s.kind };
  return createHash('sha256').update(canonical(content)).digest('hex');
}
