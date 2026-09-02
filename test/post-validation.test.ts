// test/post-validation.test.ts
// Every validation rule, plus grapheme-correct counting across textUnits. Pure — no DB.
import { describe, it, expect } from 'vitest';
import { validatePost, type ValidateTargetInput } from '../src/posts/validate';
import { measureText } from '../src/providers/validate';
import { createFakeProvider } from '../src/providers/adapters/fake';
import type { CapabilityDescriptor, RenderedPost } from '../src/providers/types';

const base = createFakeProvider().adapter.capabilities;
const caps = (over: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor => ({ ...base, provider: 'net', displayName: 'Net', ...over });
const target = (c: CapabilityDescriptor, rendered: RenderedPost, extra: Partial<ValidateTargetInput> = {}): ValidateTargetInput => ({
  targetId: 't1', provider: c.provider, displayName: c.displayName, caps: c, accountStatus: 'active', rendered, droppedMedia: [], pendingMedia: 0, duplicateWithinDays: null, ...extra,
});
const run = (c: CapabilityDescriptor, rendered: RenderedPost, extra?: Partial<ValidateTargetInput>, schedule = {}) =>
  validatePost({ now: new Date('2026-09-02T00:00:00Z'), schedule, targets: [target(c, rendered, extra)] });
const has = (res: ReturnType<typeof validatePost>, code: string, severity?: string) =>
  res.findings.some((f) => f.code === code && (!severity || f.severity === severity));

describe('validation rules', () => {
  it('text too long on a non-thread network is a blocker', () => {
    const res = run(caps({ maxTextLength: 5, threadSupport: 'none' }), { text: 'hello world', media: [] });
    expect(has(res, 'text_too_long', 'blocker')).toBe(true);
    expect(res.canSchedule).toBe(false);
  });

  it('text too long on a thread network is a warning with a thread preview', () => {
    const res = run(caps({ maxTextLength: 12, threadSupport: 'thread' }), { text: 'Hello there. Second one. Third sentence.', media: [] });
    expect(has(res, 'text_will_split', 'warning')).toBe(true);
    expect(res.threadPreviews).toHaveLength(1);
    expect(res.canSchedule).toBe(true); // a warning does not block
  });

  it('too many and too few media', () => {
    expect(has(run(caps({ maxMediaCount: 4 }), { text: '', media: Array(5).fill({ kind: 'image', url: 'u' }) }), 'too_many_media', 'blocker')).toBe(true);
    expect(has(run(caps({ minMediaCount: 1 }), { text: '', media: [] }), 'too_few_media', 'blocker')).toBe(true);
  });

  it('a single-image network warns instead of blocking (only first shown)', () => {
    expect(has(run(caps({ maxMediaCount: 1 }), { text: '', media: [{ kind: 'image', url: 'a' }, { kind: 'image', url: 'b' }] }), 'media_truncated', 'warning')).toBe(true);
  });

  it('unsupported aspect ratio warns', () => {
    const res = run(caps({ permittedAspectRatios: [{ w: 1, h: 1 }], aspectRatioTolerance: 0.02 }), { text: '', media: [{ kind: 'image', url: 'u', width: 1600, height: 900 }] });
    expect(has(res, 'aspect_ratio', 'warning')).toBe(true);
  });

  it('video too long blocks', () => {
    expect(has(run(caps({ maxVideoLengthSec: 60 }), { text: '', media: [{ kind: 'video', url: 'u', durationSec: 120 }] }), 'video_too_long', 'blocker')).toBe(true);
  });

  it('first comment on a network with none warns', () => {
    expect(has(run(caps({ supportsFirstComment: false }), { text: 'hi', media: [], firstComment: 'first!' }), 'first_comment_unsupported', 'warning')).toBe(true);
  });

  it('an account needing reauthorization blocks', () => {
    const res = run(caps(), { text: 'hi', media: [] }, { accountStatus: 'auth_expired' });
    expect(has(res, 'account_reauth_required', 'blocker')).toBe(true);
    expect(res.canSchedule).toBe(false);
  });

  it('a scheduled time in the past blocks (post-level)', () => {
    const res = run(caps(), { text: 'hi', media: [] }, {}, { type: 'fixed_instant', scheduledAt: new Date('2000-01-01T00:00:00Z') });
    expect(res.findings.some((f) => f.code === 'schedule_in_past' && f.severity === 'blocker' && f.targetId === null)).toBe(true);
  });

  it('a follower_broadcast surface is flagged as not a public feed (info)', () => {
    expect(has(run(caps({ publicationSurface: 'follower_broadcast' }), { text: 'hi', media: [] }), 'surface_not_public', 'info')).toBe(true);
  });

  it('a near-duplicate in the last 30 days warns', () => {
    expect(has(run(caps(), { text: 'hi', media: [] }, { duplicateWithinDays: 3 }), 'duplicate_recent', 'warning')).toBe(true);
  });

  it('a clean target reports all_clear (info) and can schedule', () => {
    const res = run(caps({ publicationSurface: 'public_feed' }), { text: 'looks good', media: [] });
    expect(has(res, 'all_clear', 'info')).toBe(true);
    expect(res.canSchedule).toBe(true);
  });
});

describe('character counter uses the network textUnit', () => {
  it('exposes counts the front end must not recompute', () => {
    const res = run(caps({ textUnit: 'graphemes', maxTextLength: 100 }), { text: '👨‍👩‍👧‍👦', media: [] });
    expect(res.counts[0].count).toBe(1);      // one grapheme, not 11 UTF-16 units
    expect(res.counts[0].unit).toBe('graphemes');
    expect(res.counts[0].remaining).toBe(99);
  });
});

describe('grapheme-correct counting across scripts and units', () => {
  const family = '👨‍👩‍👧‍👦';
  const flag = '🇻🇳';
  const viet = 'Vi' + 'ệ' + 't'; // "Việt" decomposed: e + dot-below + circumflex
  const hindi = 'नमस्ते';
  const thai = 'สวัสดี';

  it('emoji ZWJ family and flag are one grapheme but many code points / UTF-16 units', () => {
    expect(measureText(family, 'graphemes')).toBe(1);
    expect(measureText(family, 'code_points')).toBe(7);
    expect(measureText(family, 'utf16_units')).toBe(11);
    expect(family.length).toBe(11); // proves naive .length disagrees
    expect(measureText(flag, 'graphemes')).toBe(1);
    expect(measureText(flag, 'code_points')).toBe(2);
    expect(measureText(flag, 'utf16_units')).toBe(4);
  });

  it('Vietnamese/Hindi/Thai count fewer graphemes than code points', () => {
    // NFD guarantees the accented vowel is decomposed (e + combining marks), so the divergence is
    // deterministic regardless of how the source file stored the literal.
    const vietNFD = viet.normalize('NFD');
    expect(measureText(vietNFD, 'graphemes')).toBe(4);
    expect(measureText(vietNFD, 'code_points')).toBe(6);
    expect(measureText(hindi, 'graphemes')).toBeLessThan(measureText(hindi, 'code_points'));
    expect(measureText(thai, 'graphemes')).toBeLessThan(measureText(thai, 'code_points'));
  });

  it('bytes unit counts UTF-8 bytes', () => {
    expect(measureText('a', 'bytes')).toBe(1);
    expect(measureText('é', 'bytes')).toBe(2); // U+00E9 is 2 bytes in UTF-8
  });
});
