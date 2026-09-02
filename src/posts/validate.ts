// src/posts/validate.ts
// The validation engine. Pure: the service assembles DB data into ValidatePostInput and this returns
// structured findings (one per target per issue), per-target character counts, and thread previews.
// Messages are USER-FACING copy — short, specific, name the network, say what happens or what to do.
// No codes or jargon in the message; the machine-readable `code` is separate.
import type { CapabilityDescriptor, RenderedPost } from '../providers/types';
import { measureText } from '../providers/validate';
import { splitIntoThread } from './threads';

export type Severity = 'blocker' | 'warning' | 'info';

export interface Finding {
  targetId: string | null; // null = post-level
  provider: string | null;
  code: string;
  severity: Severity;
  message: string;
  suggestion?: string;
}

export interface CharCount {
  targetId: string;
  provider: string;
  unit: CapabilityDescriptor['textUnit'];
  count: number;
  limit: number;
  remaining: number;
}

export interface ThreadPreview {
  targetId: string;
  provider: string;
  parts: string[];
}

export interface ValidateTargetInput {
  targetId: string;
  provider: string;
  displayName: string;
  caps: CapabilityDescriptor;
  accountStatus: string; // 'active' | 'auth_expired' | ...
  rendered: RenderedPost;
  droppedMedia: string[];
  pendingMedia: number;  // referenced assets still uploading/processing (not yet probed) — blocks scheduling
  duplicateWithinDays: number | null; // days since a near-identical post to this account, else null
}

export interface ValidatePostInput {
  now: Date;
  schedule: { type?: string | null; scheduledAt?: Date | null };
  targets: ValidateTargetInput[];
}

export interface ValidationResponse {
  findings: Finding[];
  counts: CharCount[];
  threadPreviews: ThreadPreview[];
  canSchedule: boolean; // no blockers
}

function unitWord(unit: CapabilityDescriptor['textUnit']): string {
  return unit === 'bytes' ? 'bytes' : 'characters';
}
function mediaWord(post: RenderedPost, plural: boolean): string {
  const kinds = new Set(post.media.map((m) => m.kind));
  const base = kinds.size === 1 ? [...kinds][0] : 'media item';
  return plural ? `${base}s` : base;
}

export function validatePost(input: ValidatePostInput): ValidationResponse {
  const findings: Finding[] = [];
  const counts: CharCount[] = [];
  const threadPreviews: ThreadPreview[] = [];

  // Post-level: a fixed instant in the past can't be scheduled.
  if (input.schedule.type === 'fixed_instant' && input.schedule.scheduledAt && input.schedule.scheduledAt <= input.now) {
    findings.push({ targetId: null, provider: null, code: 'schedule_in_past', severity: 'blocker', message: 'That time has already passed — pick a time in the future.' });
  }

  for (const t of input.targets) {
    const before = findings.length;
    const { caps, rendered, displayName } = t;
    const count = measureText(rendered.text, caps.textUnit);
    counts.push({ targetId: t.targetId, provider: t.provider, unit: caps.textUnit, count, limit: caps.maxTextLength, remaining: caps.maxTextLength - count });

    const add = (code: string, severity: Severity, message: string, suggestion?: string) =>
      findings.push({ targetId: t.targetId, provider: t.provider, code, severity, message, suggestion });

    // Account health first — nothing else matters if it can't publish.
    if (t.accountStatus !== 'active') {
      add('account_reauth_required', 'blocker', `Reconnect ${displayName} — the connection expired, so this won't publish until you sign in again.`);
    }

    // An asset still being probed isn't publishable yet — scheduling must wait for it.
    if (t.pendingMedia > 0) {
      add('media_processing', 'blocker', `${t.pendingMedia} media file${t.pendingMedia === 1 ? ' is' : 's are'} still processing — you can schedule once ${t.pendingMedia === 1 ? 'it' : 'they'} finish.`);
    }

    // Text length: thread-capable networks split (warning); others block.
    if (count > caps.maxTextLength) {
      if (caps.threadSupport === 'thread') {
        const split = splitIntoThread(rendered.text, caps);
        threadPreviews.push({ targetId: t.targetId, provider: t.provider, parts: split.parts });
        add('text_will_split', 'warning', `${displayName} caption is ${count}/${caps.maxTextLength} — Meridian will split it into ${split.parts.length} posts.`);
      } else {
        add('text_too_long', 'blocker', `${displayName} caption is ${count}, ${caps.maxTextLength} max. Trim ${count - caps.maxTextLength} ${unitWord(caps.textUnit)}.`, 'Shorten the caption or move detail to a first comment.');
      }
    }

    // Media count.
    const n = rendered.media.length;
    if (caps.minMediaCount > 0 && n < caps.minMediaCount) {
      add('too_few_media', 'blocker', `${displayName} needs at least ${caps.minMediaCount} ${mediaWord(rendered, caps.minMediaCount > 1)}. Add ${caps.minMediaCount - n}.`);
    }
    if (n > caps.maxMediaCount) {
      if (caps.maxMediaCount === 1) {
        add('media_truncated', 'warning', `${displayName}: only the first ${mediaWord(rendered, false)} will be shown. Pick which one leads.`);
      } else {
        add('too_many_media', 'blocker', `${displayName} allows ${caps.maxMediaCount} ${mediaWord(rendered, true)}, you have ${n}. Remove ${n - caps.maxMediaCount}.`);
      }
    }

    // Per-item media checks.
    for (const m of rendered.media) {
      if (!caps.acceptedMediaTypes.includes(m.kind)) {
        add('media_type_unsupported', 'blocker', `${displayName} doesn't accept ${m.kind}. Swap it for ${caps.acceptedMediaTypes.join(' or ')}.`);
      }
      if (m.kind === 'video' && caps.maxVideoLengthSec && m.durationSec && m.durationSec > caps.maxVideoLengthSec) {
        add('video_too_long', 'blocker', `${displayName} allows ${caps.maxVideoLengthSec}s of video; this is ${Math.round(m.durationSec)}s. Trim it.`);
      }
      if (m.width && m.height && caps.permittedAspectRatios !== 'any') {
        const ratio = m.width / m.height;
        const ok = caps.permittedAspectRatios.some((ar) => Math.abs(ratio - ar.w / ar.h) <= caps.aspectRatioTolerance);
        if (!ok) {
          if (m.kind === 'video') {
            // A video can't be safely re-cropped to a different shape — this is a hard blocker, not a
            // "might crop" warning. Name the orientation the network needs.
            const want = caps.permittedAspectRatios[0];
            const haveOrient = ratio < 1 ? 'portrait' : ratio > 1 ? 'landscape' : 'square';
            const wantOrient = want.w / want.h < 1 ? 'portrait' : want.w / want.h > 1 ? 'landscape' : 'square';
            add('video_wrong_aspect', 'blocker', `This video is ${haveOrient}; ${displayName} needs a ${wantOrient} video (${want.w}:${want.h}). Re-crop it or use a different clip.`);
          } else {
            add('aspect_ratio', 'warning', `${displayName} may crop this — it isn't one of the sizes ${displayName} shows uncropped.`);
          }
        }
      }
    }

    // First comment on a network that has none.
    if (rendered.firstComment && !caps.supportsFirstComment) {
      add('first_comment_unsupported', 'warning', `${displayName} has no first comment — Meridian will skip it here.`);
    }

    // A referenced-but-removed asset was dropped from what will publish.
    if (t.droppedMedia.length > 0) {
      add('media_dropped', 'info', `A removed image was left out of the ${displayName} post.`);
    }

    // Publication surface expectation.
    if (caps.publicationSurface === 'follower_broadcast') {
      add('surface_not_public', 'info', `${displayName} sends this to your followers, not a public feed — it won't be publicly discoverable.`);
    } else if (caps.publicationSurface === 'channel') {
      add('surface_not_public', 'info', `${displayName} posts this to your channel, not a public feed.`);
    }

    // Near-duplicate to the same account recently.
    if (t.duplicateWithinDays !== null) {
      add('duplicate_recent', 'warning', `You posted nearly identical content to this ${displayName} account ${t.duplicateWithinDays} day${t.duplicateWithinDays === 1 ? '' : 's'} ago.`);
    }

    // If a target picked up nothing at all, say so positively (matches the design's "all pass").
    const targetFindings = findings.slice(before).filter((f) => f.targetId === t.targetId);
    if (!targetFindings.some((f) => f.severity !== 'info')) {
      add('all_clear', 'info', `${displayName}: length, media and aspect ratio all pass.`);
    }
  }

  return { findings, counts, threadPreviews, canSchedule: !findings.some((f) => f.severity === 'blocker') };
}
