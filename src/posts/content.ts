// src/posts/content.ts
// The parent content, the override, the ONE merge function, and the resolver that turns merged
// content into the RenderedPost the publisher will send. Encoding (matches the DB, Phase 1/4):
//   parent columns hold the shared content; an override column that is NULL means INHERIT, and a
//   non-NULL value (including '' or []) is an EXPLICIT override. In code we model "inherit" as the
//   KEY BEING ABSENT from the override object, so the merge is a plain, testable key check.
import type { RenderedMedia, RenderedPost } from '../providers/types';

export interface PostContent {
  text: string;
  link: string | null;
  firstComment: string | null;
  media: string[]; // ordered media_asset ids
}

// Presence of a key = overridden (value may be '' or []). Absence = inherit.
export interface OverrideContent {
  text?: string;
  link?: string;
  firstComment?: string;
  media?: string[];
}

// THE merge. Pure. A key present in `override` wins (even '' / []); absent inherits from parent.
export function mergeContent(parent: PostContent, override: OverrideContent): PostContent {
  return {
    text: 'text' in override ? override.text! : parent.text,
    link: 'link' in override ? (override.link ?? null) : parent.link,
    firstComment: 'firstComment' in override ? (override.firstComment ?? null) : parent.firstComment,
    media: 'media' in override ? override.media! : parent.media,
  };
}

// Build an OverrideContent from a post_target_overrides row: NULL column => key absent (inherit).
export function overrideFromRow(row: {
  text_override: string | null;
  link_override: string | null;
  first_comment_override: string | null;
  media_override: string[] | null;
}): OverrideContent {
  const o: OverrideContent = {};
  if (row.text_override !== null) o.text = row.text_override;
  if (row.link_override !== null) o.link = row.link_override;
  if (row.first_comment_override !== null) o.firstComment = row.first_comment_override;
  if (row.media_override !== null) o.media = row.media_override;
  return o;
}

export interface MediaAssetInfo {
  id: string;
  kind: 'image' | 'video' | 'gif';
  url: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  mimeType?: string;
  altText?: string;
  status: string; // 'ready' etc.
}

// Resolve merged content to the exact RenderedPost the publisher will send. Media ids that no
// longer resolve (deleted asset) or aren't 'ready' are DROPPED here — so a removed asset can never
// leave a dangling reference in what actually publishes. Dropped ids are reported for a UI notice.
export function renderTarget(merged: PostContent, media: Map<string, MediaAssetInfo>): { post: RenderedPost; droppedMedia: string[] } {
  const rendered: RenderedMedia[] = [];
  const dropped: string[] = [];
  for (const id of merged.media) {
    const a = media.get(id);
    if (!a || a.status !== 'ready') { dropped.push(id); continue; }
    rendered.push({ kind: a.kind, url: a.url, bytes: a.bytes, width: a.width, height: a.height, durationSec: a.durationSec, mimeType: a.mimeType, altText: a.altText });
  }
  const post: RenderedPost = { text: merged.text, media: rendered };
  if (merged.link) post.link = merged.link;
  if (merged.firstComment) post.firstComment = merged.firstComment;
  return { post, droppedMedia: dropped };
}

// Scrub a deleted media id from parent content and an override list (pure). The service applies
// this to posts.content and every post_target_overrides.media_override in the workspace when an
// asset is deleted, so no draft keeps a dangling reference.
export function scrubMediaId<T extends { media: string[] }>(content: T, assetId: string): T {
  return { ...content, media: content.media.filter((m) => m !== assetId) };
}

// Deterministic, key-sorted serialization — used to prove the preview payload is byte-identical to
// what gets persisted (and later published).
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = sortKeys((v as Record<string, unknown>)[k]);
      return acc;
    }, {});
  }
  return v;
}
