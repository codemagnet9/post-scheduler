// src/posts/service.ts
// Post + target CRUD, override writes, and the assembly that feeds the pure validation engine.
// Enforces the post:create/update/view_drafts abilities and the lifecycle-state gate (only draft /
// changes_requested are editable).
import { sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/tenant';
import { pgArray } from '../db/index';
import { authorize, type Actor } from '../authz/abilities';
import { resolveAdapter } from '../providers/registry';
import { contentFingerprint } from '../providers/fingerprint';
import { writeAudit } from '../audit/audit';
import {
  mergeContent, overrideFromRow, renderTarget, canonicalJSON,
  type PostContent, type MediaAssetInfo,
} from './content';
import { validatePost, type ValidatePostInput, type ValidateTargetInput, type ValidationResponse } from './validate';

export class PostError extends Error {
  constructor(code: string) { super(code); this.name = 'PostError'; }
}

export type ScopedActor = Actor & { workspaceId: string };
type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

const DRAFTISH = ['draft', 'pending_approval', 'changes_requested', 'approved'];
const isDraftish = (status: string): boolean => DRAFTISH.includes(status);
const isEditable = (status: string): boolean => status === 'draft' || status === 'changes_requested';

function normalizeContent(c?: Partial<PostContent>): PostContent {
  return { text: c?.text ?? '', link: c?.link ?? null, firstComment: c?.firstComment ?? null, media: c?.media ?? [] };
}

async function loadPostRow(tx: Tx, postId: string) {
  const r = rows<{ id: string; author_id: string | null; status: string; content: PostContent; schedule_type: string | null; scheduled_at: Date | null; scheduled_local_time: string | null; scheduled_local_date: string | null; queue_market_timezone: string | null }>(
    await tx.execute(sql`
      select id, author_id, status, content, schedule_type, scheduled_at, scheduled_local_time, scheduled_local_date, queue_market_timezone
      from posts where id = ${postId}
    `),
  );
  if (!r.length) throw new PostError('not_found'); // RLS => cross-tenant is also not_found
  return r[0];
}

async function loadMediaMap(tx: Tx, ids: string[]): Promise<Map<string, MediaAssetInfo>> {
  const map = new Map<string, MediaAssetInfo>();
  if (!ids.length) return map;
  const r = rows<{ id: string; kind: 'image' | 'video' | 'gif'; storage_key: string; mime_type: string; byte_size: number | null; width: number | null; height: number | null; duration_ms: number | null; status: string }>(
    await tx.execute(sql`
      select id, kind, storage_key, mime_type, byte_size, width, height, duration_ms, status
      from media_assets where id = any(${pgArray(ids)}::uuid[])
    `),
  );
  for (const a of r) {
    map.set(a.id, {
      id: a.id, kind: a.kind, url: a.storage_key, mimeType: a.mime_type, status: a.status,
      bytes: a.byte_size ?? undefined, width: a.width ?? undefined, height: a.height ?? undefined,
      durationSec: a.duration_ms != null ? a.duration_ms / 1000 : undefined,
    });
  }
  return map;
}

// --- CRUD ---

export async function createDraft(actor: ScopedActor, input: { content?: Partial<PostContent>; targetAccountIds: string[] }) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'post:create');
    const content = normalizeContent(input.content);
    const post = rows<{ id: string }>(await tx.execute(sql`
      insert into posts (workspace_id, author_id, status, content) values (${actor.workspaceId}, ${actor.userId}, 'draft', ${JSON.stringify(content)}::jsonb) returning id
    `))[0];
    for (const accountId of new Set(input.targetAccountIds)) {
      await tx.execute(sql`
        insert into post_targets (post_id, workspace_id, connected_account_id, state)
        values (${post.id}, ${actor.workspaceId}, ${accountId}, 'draft')
        on conflict (post_id, connected_account_id) do nothing
      `);
    }
    await writeAudit(tx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: 'post.created', targetType: 'post', targetId: post.id });
    return { postId: post.id };
  });
}

export async function getPost(actor: ScopedActor, postId: string) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const post = await loadPostRow(tx, postId);
    authorize(actor, isDraftish(post.status) ? 'post:view_drafts' : 'post:view', { authorId: post.author_id ?? undefined });
    const targets = rows(await tx.execute(sql`
      select pt.id as target_id, pt.connected_account_id, ca.provider, ca.handle, ca.display_name, ca.status as account_status,
             o.text_override, o.link_override, o.first_comment_override, o.media_override
      from post_targets pt
      join connected_accounts ca on ca.id = pt.connected_account_id
      left join post_target_overrides o on o.post_target_id = pt.id
      where pt.post_id = ${postId}
      order by ca.display_name
    `));
    return { id: post.id, status: post.status, authorId: post.author_id, content: post.content,
      schedule: { type: post.schedule_type, scheduledAt: post.scheduled_at, localTime: post.scheduled_local_time, localDate: post.scheduled_local_date }, targets };
  });
}

export async function updatePost(actor: ScopedActor, postId: string, patch: Partial<PostContent>) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const post = await loadPostRow(tx, postId);
    authorize(actor, 'post:update', { authorId: post.author_id ?? undefined });
    if (!isEditable(post.status)) throw new PostError('not_editable');
    // Editing shared content only touches the parent; overriding targets are unaffected by the merge.
    const next = { ...post.content, ...patch };
    await tx.execute(sql`update posts set content = ${JSON.stringify(next)}::jsonb, updated_at = now() where id = ${postId}`);
    return { ok: true };
  });
}

export async function deletePost(actor: ScopedActor, postId: string) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const post = await loadPostRow(tx, postId);
    authorize(actor, 'post:delete', { authorId: post.author_id ?? undefined });
    if (!isEditable(post.status)) throw new PostError('not_editable');
    await tx.execute(sql`delete from posts where id = ${postId}`); // cascades targets + overrides
    await writeAudit(tx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: 'post.deleted', targetType: 'post', targetId: postId });
    return { ok: true };
  });
}

export async function duplicatePost(actor: ScopedActor, postId: string) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const src = await loadPostRow(tx, postId);
    authorize(actor, isDraftish(src.status) ? 'post:view_drafts' : 'post:view', { authorId: src.author_id ?? undefined });
    authorize(actor, 'post:create');
    const copy = rows<{ id: string }>(await tx.execute(sql`
      insert into posts (workspace_id, author_id, status, content) values (${actor.workspaceId}, ${actor.userId}, 'draft', ${JSON.stringify(src.content)}::jsonb) returning id
    `))[0];
    const srcTargets = rows<{ id: string; connected_account_id: string; text_override: string | null; link_override: string | null; first_comment_override: string | null; media_override: unknown }>(
      await tx.execute(sql`
        select pt.id, pt.connected_account_id, o.text_override, o.link_override, o.first_comment_override, o.media_override
        from post_targets pt left join post_target_overrides o on o.post_target_id = pt.id where pt.post_id = ${postId}
      `),
    );
    for (const t of srcTargets) {
      const nt = rows<{ id: string }>(await tx.execute(sql`
        insert into post_targets (post_id, workspace_id, connected_account_id, state) values (${copy.id}, ${actor.workspaceId}, ${t.connected_account_id}, 'draft') returning id
      `))[0];
      if (t.text_override !== null || t.link_override !== null || t.first_comment_override !== null || t.media_override !== null) {
        await tx.execute(sql`
          insert into post_target_overrides (post_target_id, workspace_id, text_override, link_override, first_comment_override, media_override)
          values (${nt.id}, ${actor.workspaceId}, ${t.text_override}, ${t.link_override}, ${t.first_comment_override}, ${t.media_override === null ? null : JSON.stringify(t.media_override)}::jsonb)
        `);
      }
    }
    return { postId: copy.id };
  });
}

export async function addTarget(actor: ScopedActor, postId: string, accountId: string) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const post = await loadPostRow(tx, postId);
    authorize(actor, 'post:update', { authorId: post.author_id ?? undefined });
    if (!isEditable(post.status)) throw new PostError('not_editable');
    const t = rows<{ id: string }>(await tx.execute(sql`
      insert into post_targets (post_id, workspace_id, connected_account_id, state) values (${postId}, ${actor.workspaceId}, ${accountId}, 'draft')
      on conflict (post_id, connected_account_id) do nothing returning id
    `));
    return { targetId: t[0]?.id ?? null };
  });
}

export async function removeTarget(actor: ScopedActor, postId: string, targetId: string) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const post = await loadPostRow(tx, postId);
    authorize(actor, 'post:update', { authorId: post.author_id ?? undefined });
    if (!isEditable(post.status)) throw new PostError('not_editable');
    await tx.execute(sql`delete from post_targets where id = ${targetId} and post_id = ${postId}`); // cascades override
    return { ok: true };
  });
}

// Per-field override write. value => set (incl '' / []); null => clear (inherit); absent => unchanged.
export interface OverridePatch { text?: string | null; link?: string | null; firstComment?: string | null; media?: string[] | null }

export async function setOverride(actor: ScopedActor, postId: string, targetId: string, patch: OverridePatch) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const post = await loadPostRow(tx, postId);
    authorize(actor, 'post:update', { authorId: post.author_id ?? undefined });
    if (!isEditable(post.status)) throw new PostError('not_editable');
    const existing = rows<{ text_override: string | null; link_override: string | null; first_comment_override: string | null; media_override: unknown }>(
      await tx.execute(sql`select text_override, link_override, first_comment_override, media_override from post_target_overrides where post_target_id = ${targetId}`),
    )[0] ?? { text_override: null, link_override: null, first_comment_override: null, media_override: null };

    const pick = <T>(key: keyof OverridePatch, current: T): T => (key in patch ? (patch[key] as unknown as T) : current);
    const text = pick('text', existing.text_override);
    const link = pick('link', existing.link_override);
    const firstComment = pick('firstComment', existing.first_comment_override);
    const media = ('media' in patch ? patch.media : existing.media_override) as string[] | null;

    await tx.execute(sql`
      insert into post_target_overrides (post_target_id, workspace_id, text_override, link_override, first_comment_override, media_override)
      values (${targetId}, ${actor.workspaceId}, ${text}, ${link}, ${firstComment}, ${media === null ? null : JSON.stringify(media)}::jsonb)
      on conflict (post_target_id) do update set
        text_override = excluded.text_override, link_override = excluded.link_override,
        first_comment_override = excluded.first_comment_override, media_override = excluded.media_override, updated_at = now()
    `);
    return { ok: true };
  });
}

export async function setSchedule(actor: ScopedActor, postId: string, schedule: { type: 'fixed_instant' | 'audience_local' | 'queued'; scheduledAt?: string | null; localTime?: string | null; localDate?: string | null; queueMarketTimezone?: string | null }) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const post = await loadPostRow(tx, postId);
    authorize(actor, 'post:update', { authorId: post.author_id ?? undefined });
    if (!isEditable(post.status)) throw new PostError('not_editable');
    await tx.execute(sql`
      update posts set schedule_type = ${schedule.type}, scheduled_at = ${schedule.scheduledAt ?? null},
        scheduled_local_time = ${schedule.localTime ?? null}, scheduled_local_date = ${schedule.localDate ?? null},
        queue_market_timezone = ${schedule.queueMarketTimezone ?? null}, updated_at = now()
      where id = ${postId}
    `);
    return { ok: true };
  });
}

export async function listAccounts(actor: ScopedActor) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'account:view');
    return tx.execute(sql`
      select id, provider, handle, display_name, status, timezone from connected_accounts
      where status <> 'disconnected' order by display_name
    `);
  });
}

// --- validation assembly (feeds the pure engine) ---

export async function validatePostService(actor: ScopedActor, postId: string): Promise<ValidationResponse> {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const post = await loadPostRow(tx, postId);
    authorize(actor, isDraftish(post.status) ? 'post:view_drafts' : 'post:view', { authorId: post.author_id ?? undefined });

    const targetRows = rows<{ target_id: string; connected_account_id: string; provider: string; display_name: string | null; handle: string | null; account_status: string; text_override: string | null; link_override: string | null; first_comment_override: string | null; media_override: string[] | null }>(
      await tx.execute(sql`
        select pt.id as target_id, pt.connected_account_id, ca.provider, ca.display_name, ca.handle, ca.status as account_status,
               o.text_override, o.link_override, o.first_comment_override, o.media_override
        from post_targets pt
        join connected_accounts ca on ca.id = pt.connected_account_id
        left join post_target_overrides o on o.post_target_id = pt.id
        where pt.post_id = ${postId}
      `),
    );

    // All media ids referenced by parent or any override.
    const mediaIds = new Set<string>(post.content.media);
    for (const t of targetRows) if (t.media_override) t.media_override.forEach((m) => mediaIds.add(m));
    const mediaMap = await loadMediaMap(tx, [...mediaIds]);

    const targets: ValidateTargetInput[] = [];
    for (const t of targetRows) {
      const override = overrideFromRow(t);
      const merged = mergeContent(post.content, override);
      const { post: rendered, droppedMedia } = renderTarget(merged, mediaMap);
      // Referenced assets that exist but aren't 'ready' yet block scheduling (still probing).
      const pendingMedia = merged.media.filter((id) => { const a = mediaMap.get(id); return a !== undefined && a.status !== 'ready'; }).length;
      const caps = resolveAdapter(t.provider).capabilities;

      // Near-duplicate to the same account in the last 30 days (by content fingerprint).
      const fp = contentFingerprint(rendered);
      const dup = rows<{ days: number }>(await tx.execute(sql`
        select floor(extract(epoch from (now() - max(published_at))) / 86400)::int as days
        from post_targets
        where connected_account_id = ${t.connected_account_id} and state = 'published'
          and content_fingerprint = ${fp} and published_at > now() - interval '30 days'
        having max(published_at) is not null
      `));

      targets.push({
        targetId: t.target_id, provider: t.provider, displayName: t.display_name ?? t.handle ?? caps.displayName,
        caps, accountStatus: t.account_status, rendered, droppedMedia, pendingMedia,
        duplicateWithinDays: dup.length ? dup[0].days : null,
      });
    }

    const input: ValidatePostInput = {
      now: new Date(),
      schedule: { type: post.schedule_type, scheduledAt: post.scheduled_at },
      targets,
    };
    return validatePost(input);
  });
}

// Render a target's payload exactly as it will be persisted (rendered_payload) and later published.
// The composer preview and the publisher both go through this — that is the round-trip guarantee.
export function renderTargetForPersistence(parent: PostContent, override: ReturnType<typeof overrideFromRow>, media: Map<string, MediaAssetInfo>) {
  const merged = mergeContent(parent, override);
  const { post } = renderTarget(merged, media);
  return { payload: post, canonical: canonicalJSON(post) };
}
