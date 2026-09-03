// src/scheduling/schedule.ts
// The draft -> scheduled transition: validate (no blockers), freeze each target's rendered_payload,
// and materialize the schedule intent into one absolute UTC instant per target (audience-local =>
// N instants; fixed/queued => one shared instant). rendered_payload is frozen here so the claim
// only reads it.
import { sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/tenant';
import { pgArray, toTs } from '../db/index';
import { authorize } from '../authz/abilities';
import { emitEvent } from '../events/emit';
import { mergeContent, overrideFromRow, type PostContent, type MediaAssetInfo } from '../posts/content';
import { resolveTargetInstant, type ScheduleIntent } from './time';
import { PostError, type ScopedActor } from '../posts/service';
import { validatePostService } from '../posts/service';
import { resolveAdapter } from '../providers/registry';
import { computeVariantSpec, ensureVariant, getVariantRenderer } from '../media/variants';
import { getStorage } from '../media/storage';
import type { RenderedMedia, RenderedPost } from '../providers/types';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

async function loadMediaMap(tx: Tx, ids: string[]): Promise<Map<string, MediaAssetInfo>> {
  const map = new Map<string, MediaAssetInfo>();
  if (!ids.length) return map;
  const r = rows<{ id: string; kind: 'image' | 'video' | 'gif'; storage_key: string; mime_type: string; byte_size: number | null; width: number | null; height: number | null; duration_ms: number | null; status: string }>(
    await tx.execute(sql`select id, kind, storage_key, mime_type, byte_size, width, height, duration_ms, status from media_assets where id = any(${pgArray(ids)}::uuid[])`),
  );
  for (const a of r) map.set(a.id, { id: a.id, kind: a.kind, url: a.storage_key, mimeType: a.mime_type, status: a.status, bytes: a.byte_size ?? undefined, width: a.width ?? undefined, height: a.height ?? undefined, durationSec: a.duration_ms != null ? a.duration_ms / 1000 : undefined });
  return map;
}

// THE DIRECT-SCHEDULE GATE. Only Owner/Approver (post:schedule) may schedule a post directly, and
// only a draft/changes_requested one. Editors lack post:schedule, so they CANNOT bypass review — they
// must submit -> have an Approver approve. A pending_approval post is likewise not directly
// schedulable: it goes out only via the approval path (approvals/service.ts approve()).
export async function schedulePost(actor: ScopedActor, postId: string): Promise<{ scheduled: number }> {
  await withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const p = rows<{ author_id: string | null; status: string }>(await tx.execute(sql`select author_id, status from posts where id = ${postId}`))[0];
    if (!p) throw new PostError('not_found');
    authorize(actor, 'post:schedule', { authorId: p.author_id ?? undefined });
    if (p.status !== 'draft' && p.status !== 'changes_requested') throw new PostError('not_schedulable');
  });
  return materializeAndSchedule(actor, postId);
}

// Shared core used by BOTH the direct gate above and the approval path. No ability check here — the
// caller has already authorized. Accepts pending_approval (from approve()).
export async function materializeAndSchedule(actor: ScopedActor, postId: string): Promise<{ scheduled: number }> {
  // Validation must pass with no blockers before anything is materialized (includes schedule_in_past,
  // which is how a time that lapsed while the post sat unapproved blocks approval — case c).
  const validation = await validatePostService(actor, postId);
  if (!validation.canSchedule) throw new PostError('has_blockers');

  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const post = rows<{ id: string; author_id: string | null; status: string; content: PostContent; schedule_type: ScheduleIntent['type'] | null; scheduled_at: string | null; scheduled_local_time: string | null; scheduled_local_date: string | null }>(
      await tx.execute(sql`select id, author_id, status, content, schedule_type, scheduled_at, scheduled_local_time, scheduled_local_date from posts where id = ${postId}`),
    )[0];
    if (!post) throw new PostError('not_found');
    if (!['draft', 'changes_requested', 'pending_approval'].includes(post.status)) throw new PostError('not_schedulable');
    if (!post.schedule_type) throw new PostError('no_schedule');

    // scheduled_at comes back from execute() as a STRING — coerce to Date for the fixed_instant path.
    const intent: ScheduleIntent = { type: post.schedule_type, scheduledAt: post.scheduled_at ? new Date(post.scheduled_at) : null, localDate: post.scheduled_local_date, localTime: post.scheduled_local_time };

    const targets = rows<{ target_id: string; provider: string; timezone: string; text_override: string | null; link_override: string | null; first_comment_override: string | null; media_override: string[] | null }>(
      await tx.execute(sql`
        select pt.id as target_id, ca.provider, ca.timezone, o.text_override, o.link_override, o.first_comment_override, o.media_override
        from post_targets pt join connected_accounts ca on ca.id = pt.connected_account_id
        left join post_target_overrides o on o.post_target_id = pt.id
        where pt.post_id = ${postId} and pt.state = 'draft'
      `),
    );

    const mediaIds = new Set<string>(post.content.media);
    for (const t of targets) if (t.media_override) t.media_override.forEach((m) => mediaIds.add(m));
    const mediaMap = await loadMediaMap(tx, [...mediaIds]);

    let scheduled = 0;
    for (const t of targets) {
      const merged = mergeContent(post.content, overrideFromRow(t));
      const caps = resolveAdapter(t.provider).capabilities;

      // Select the network-appropriate VARIANT per media and freeze its STORAGE KEY (not the original
      // asset key) into rendered_payload, generating+caching the variant on first use. A source that
      // can't satisfy the network is 'unsatisfiable', but validation already blocked that above.
      const media: RenderedMedia[] = [];
      for (const mediaId of merged.media) {
        const a = mediaMap.get(mediaId);
        if (!a || a.status !== 'ready') continue; // pending/missing were caught by validation
        const decision = computeVariantSpec(caps, { width: a.width, height: a.height, bytes: a.bytes ?? 0, durationSec: a.durationSec }, a.kind);
        let storageKey = a.url; // original storage key
        let width = a.width;
        let height = a.height;
        if (decision.kind === 'variant') {
          const v = await ensureVariant(tx, getStorage(), getVariantRenderer(), { assetId: a.id, workspaceId: actor.workspaceId, sourceKey: a.url, spec: decision.spec });
          storageKey = v.storageKey;
          width = decision.spec.targetWidth;
          height = decision.spec.targetHeight;
        }
        media.push({ kind: a.kind, url: storageKey, bytes: a.bytes, width, height, durationSec: a.durationSec, mimeType: a.mimeType, altText: a.altText });
      }
      const renderedPayload: RenderedPost = { text: merged.text, media };
      if (merged.link) renderedPayload.link = merged.link;
      if (merged.firstComment) renderedPayload.firstComment = merged.firstComment;

      const { instant } = resolveTargetInstant(intent, t.timezone);
      const upd = rows(await tx.execute(sql`
        update post_targets set state = 'scheduled', scheduled_at = ${toTs(instant)}, publish_due_at = ${toTs(instant)},
          rendered_payload = ${JSON.stringify(renderedPayload)}::jsonb, version = version + 1
        where id = ${t.target_id} and state = 'draft' returning id
      `));
      if (upd.length) {
        scheduled += 1;
        await emitEvent(tx, { workspaceId: actor.workspaceId, aggregateType: 'post_target', aggregateId: t.target_id, type: 'post_target.scheduled', payload: { scheduledAt: instant.toISOString() } });
      }
    }
    await tx.execute(sql`update posts set status = 'scheduled', updated_at = now() where id = ${postId}`);
    return { scheduled };
  });
}
