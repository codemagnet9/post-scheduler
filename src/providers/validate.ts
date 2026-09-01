// src/providers/validate.ts
// ONE validation implementation, driven by the capability descriptor. Both the pre-schedule
// validator (composer warnings, Phase 5) and the publisher's pre-flight check (Phase 6) call this,
// so the warnings the user sees and the checks the publisher enforces cannot drift.
import type { CapabilityDescriptor, RenderedPost, TextUnit, ValidationIssue, ValidationResult } from './types';

// Measure text in the unit the network actually counts in. .length (UTF-16 units) diverges from
// graphemes for Vietnamese, Hindi, Thai, CJK and emoji — the exact markets this product targets —
// so a Latin-only .length check would pass in the composer and then fail at the provider.
export function measureText(text: string, unit: TextUnit): number {
  switch (unit) {
    case 'graphemes': {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      let n = 0;
      for (const _ of seg.segment(text)) n += 1;
      return n;
    }
    case 'code_points':
      return [...text].length;
    case 'bytes':
      return Buffer.byteLength(text, 'utf8');
    case 'utf16_units':
    default:
      return text.length;
  }
}

function aspectMatches(caps: CapabilityDescriptor, w: number, h: number): boolean {
  if (caps.permittedAspectRatios === 'any') return true;
  const ratio = w / h;
  return caps.permittedAspectRatios.some((ar) => Math.abs(ratio - ar.w / ar.h) <= caps.aspectRatioTolerance);
}

export function validateAgainstCapabilities(caps: CapabilityDescriptor, post: RenderedPost): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string) => issues.push({ level: 'error', code, message });
  const warn = (code: string, message: string) => issues.push({ level: 'warning', code, message });

  const textLen = measureText(post.text, caps.textUnit)
    + (caps.linksCountTowardText && post.link ? measureText(post.link, caps.textUnit) : 0);
  if (textLen > caps.maxTextLength) {
    err('text_too_long', `Text is ${textLen} ${caps.textUnit}; ${caps.displayName} allows ${caps.maxTextLength}.`);
  }

  const n = post.media.length;
  if (n < caps.minMediaCount) err('too_few_media', `${caps.displayName} requires at least ${caps.minMediaCount} media item(s).`);
  if (n > caps.maxMediaCount) err('too_many_media', `${caps.displayName} allows at most ${caps.maxMediaCount} media item(s); this has ${n}.`);

  for (const m of post.media) {
    if (!caps.acceptedMediaTypes.includes(m.kind)) {
      err('media_type_unsupported', `${caps.displayName} does not accept ${m.kind} media.`);
      continue;
    }
    if (m.kind === 'video') {
      if (caps.maxVideoLengthSec && m.durationSec && m.durationSec > caps.maxVideoLengthSec)
        err('video_too_long', `Video is ${Math.round(m.durationSec)}s; ${caps.displayName} allows ${caps.maxVideoLengthSec}s.`);
      if (caps.maxVideoFileBytes && m.bytes && m.bytes > caps.maxVideoFileBytes)
        err('video_too_large', `Video exceeds ${caps.displayName}'s size limit.`);
    }
    if ((m.kind === 'image' || m.kind === 'gif') && caps.maxImageFileBytes && m.bytes && m.bytes > caps.maxImageFileBytes) {
      err('image_too_large', `Image exceeds ${caps.displayName}'s size limit.`);
    }
    if (m.width && m.height && !aspectMatches(caps, m.width, m.height)) {
      warn('aspect_ratio_unsupported', `${caps.displayName} may crop this media — its aspect ratio isn't one of the recommended sizes.`);
    }
  }

  if (post.firstComment && !caps.supportsFirstComment) {
    warn('first_comment_unsupported', `${caps.displayName} doesn't support a separate first comment — it will be skipped.`);
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues };
}
