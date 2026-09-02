// src/media/signed-urls.ts
// THE SIGNED-URL RULE (the debt renderTarget carried since Phase 5):
//   rendered_payload.media[].url holds the STORAGE KEY, which is stable — so canonicalJSON is stable
//   and the preview-equals-publish guarantee holds. A signed URL EXPIRES, so it must never be part
//   of the persisted/canonicalised payload. Signed URLs are minted HERE, at publish time, from the
//   storage keys, and are never stored. Rotating a signature therefore can't break the guarantee.
import type { RenderedPost } from '../providers/types';
import type { StorageAdapter } from './storage';

const SIGNED_URL_TTL_SEC = 600;

export async function resolveMediaUrls(post: RenderedPost, storage: StorageAdapter): Promise<RenderedPost> {
  const media = await Promise.all(
    post.media.map(async (m) => ({ ...m, url: await storage.signedGetUrl(m.url, SIGNED_URL_TTL_SEC) })),
  );
  return { ...post, media };
}
