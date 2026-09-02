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
import { mergeContent, overrideFromRow, renderTarget, type PostContent, type MediaAssetInfo } from '../posts/content';
import { resolveTargetInstant, type ScheduleIntent } from './time';
import { PostError, type ScopedActor } from '../posts/service';
import { validatePostService } from '../posts/service';

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

export async function schedulePost(actor: ScopedActor, postId: string): Promise<{ scheduled: number }> {
  // Validation must pass with no blockers before anything is materialized.
  const validation = await validatePostService(actor, postId);
  if (!validation.canSchedule) throw new PostError('has_blockers');

  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const post = rows<{ id: string; author_id: string | null; status: string; content: PostContent; schedule_type: ScheduleIntent['type'] | null; scheduled_at: Date | null; scheduled_local_time: string | null; scheduled_local_date: string | null }>(
      await tx.execute(sql`select id, author_id, status, content, schedule_type, scheduled_at, scheduled_local_time, scheduled_local_date from posts where id = ${postId}`),
    )[0];
    if (!post) throw new PostError('not_found');
    authorize(actor, 'post:schedule', { authorId: post.author_id ?? undefined });
    if (post.status !== 'draft' && post.status !== 'changes_requested') throw new PostError('not_editable');
    if (!post.schedule_type) throw new PostError('no_schedule');

    const intent: ScheduleIntent = { type: post.schedule_type, scheduledAt: post.scheduled_at, localDate: post.scheduled_local_date, localTime: post.scheduled_local_time };

    const targets = rows<{ target_id: string; timezone: string; text_override: string | null; link_override: string | null; first_comment_override: string | null; media_override: string[] | null }>(
      await tx.execute(sql`
        select pt.id as target_id, ca.timezone, o.text_override, o.link_override, o.first_comment_override, o.media_override
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
      const { post: renderedPayload } = renderTarget(merged, mediaMap);
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
