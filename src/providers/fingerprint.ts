// src/providers/fingerprint.ts
import { createHash } from 'node:crypto';
import type { RenderedPost } from './types';

// A stable content fingerprint used to match a recentPosts() result against what we tried to
// publish, so an ambiguous failure can be reconciled. Normalizes whitespace so trivial formatting
// differences from the provider's echo don't break the match. Media is included by kind+url.
export function contentFingerprint(post: Pick<RenderedPost, 'text' | 'media'>): string {
  const text = post.text.replace(/\s+/g, ' ').trim();
  const media = post.media.map((m) => `${m.kind}:${m.url}`).sort().join('|');
  return createHash('sha256').update(`${text}\n${media}`).digest('hex').slice(0, 32);
}

export function textFingerprint(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
}
