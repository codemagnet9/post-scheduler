// test/override-merge.test.ts
// The merge table in full, including the cases that bite. Pure — no DB.
import { describe, it, expect } from 'vitest';
import { mergeContent, overrideFromRow, renderTarget, scrubMediaId, type PostContent, type MediaAssetInfo } from '../src/posts/content';

const parent: PostContent = { text: 'shared', link: 'https://p', firstComment: 'fc', media: ['m1', 'm2'] };

// Emulate a post_target_overrides row: NULL column => inherit.
const row = (o: Partial<{ text: string | null; link: string | null; first: string | null; media: string[] | null }>) =>
  overrideFromRow({
    text_override: o.text ?? null,
    link_override: o.link ?? null,
    first_comment_override: o.first ?? null,
    media_override: o.media ?? null,
  });

describe('override merge table', () => {
  it('empty override inherits everything', () => {
    expect(mergeContent(parent, row({}))).toEqual(parent);
  });

  it('overriding text changes only text', () => {
    expect(mergeContent(parent, row({ text: 'custom' }))).toEqual({ ...parent, text: 'custom' });
  });

  it('an override CLEARED (NULL) returns to inherited — not empty string', () => {
    // text_override = null => key absent => inherit
    expect(mergeContent(parent, row({ text: null })).text).toBe('shared');
  });

  it('an override set to empty string is EXPLICITLY empty (not inherited)', () => {
    expect(mergeContent(parent, row({ text: '' })).text).toBe('');
  });

  it('media override [] is explicit "no media"; NULL inherits', () => {
    expect(mergeContent(parent, row({ media: [] })).media).toEqual([]);
    expect(mergeContent(parent, row({ media: null })).media).toEqual(['m1', 'm2']);
  });

  it('link/firstComment follow the same NULL=inherit, value=override rule', () => {
    expect(mergeContent(parent, row({ link: null })).link).toBe('https://p');
    expect(mergeContent(parent, row({ link: '' })).link).toBe('');
    expect(mergeContent(parent, row({ first: 'x' })).firstComment).toBe('x');
  });

  it('editing the SHARED text updates inheriting targets and leaves overridden ones alone', () => {
    const inheriting = row({});                 // target A inherits text
    const overriding = row({ text: 'B-text' }); // target B overrides text
    const edited: PostContent = { ...parent, text: 'edited' };
    expect(mergeContent(edited, inheriting).text).toBe('edited'); // follows the shared edit
    expect(mergeContent(edited, overriding).text).toBe('B-text'); // untouched
  });
});

describe('no dangling media reference', () => {
  const media = new Map<string, MediaAssetInfo>([
    ['m1', { id: 'm1', kind: 'image', url: 'u1', status: 'ready' }],
    ['m2', { id: 'm2', kind: 'image', url: 'u2', status: 'ready' }],
  ]);

  it('a removed asset an override referenced is dropped from what publishes', () => {
    const override = row({ media: ['m1', 'gone', 'm2'] }); // 'gone' was deleted from the workspace
    const merged = mergeContent(parent, override);
    const { post, droppedMedia } = renderTarget(merged, media);
    expect(post.media.map((m) => m.url)).toEqual(['u1', 'u2']); // no dangling ref reaches the publisher
    expect(droppedMedia).toEqual(['gone']);
  });

  it('scrubMediaId removes a deleted id from an override list', () => {
    expect(scrubMediaId({ media: ['m1', 'gone', 'm2'] }, 'gone').media).toEqual(['m1', 'm2']);
  });
});
