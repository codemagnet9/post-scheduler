// src/media/service.ts
// Upload orchestration, probing, and lifecycle (delete + scrub + reference counting + cleanup).
import { sql } from 'drizzle-orm';
import { withTenant, type TenantContext, type Tx } from '../db/tenant';
import { authorize, type Actor } from '../authz/abilities';
import { getStorage } from './storage';
import { sniffMimeType, MIME_TO_KIND, type SniffedMime } from './sniff';
import { probeAsset } from './probe';
import { scrubMediaId } from '../posts/content';
import { writeAudit } from '../audit/audit';

export class MediaError extends Error {
  constructor(code: string) { super(code); this.name = 'MediaError'; }
}
export type ScopedActor = Actor & { workspaceId: string };
type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

const MAX_BYTES: Record<'image' | 'gif' | 'video', number> = {
  image: 10 * 1024 * 1024,
  gif: 15 * 1024 * 1024,
  video: 512 * 1024 * 1024,
};
// Posts in these states depend on the asset — it must not be deleted out from under them.
const LIVE_STATES = ['pending_approval', 'approved', 'scheduled', 'publishing', 'partially_published'];

// --- upload ---
export async function createUpload(actor: ScopedActor, input: { filename: string; declaredType: string; byteSize: number }) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'media:upload');
    const kind = (MIME_TO_KIND[input.declaredType as SniffedMime] ?? 'image') as 'image' | 'video' | 'gif';
    if (input.byteSize > MAX_BYTES[kind]) throw new MediaError('too_large');
    const asset = rows<{ id: string }>(await tx.execute(sql`
      insert into media_assets (workspace_id, uploaded_by, kind, storage_key, original_filename, mime_type, byte_size, status)
      values (${actor.workspaceId}, ${actor.userId}, ${kind}, ${'pending'}, ${input.filename}, ${input.declaredType}, ${input.byteSize}, 'uploading')
      returning id
    `))[0];
    const storageKey = `uploads/${actor.workspaceId}/${asset.id}`;
    await tx.execute(sql`update media_assets set storage_key = ${storageKey} where id = ${asset.id}`);
    const presigned = await getStorage().presignUpload(storageKey, { contentType: input.declaredType, maxBytes: MAX_BYTES[kind] });
    return { assetId: asset.id, uploadUrl: presigned.uploadUrl, storageKey };
  });
}

// The probe/finalize worker path: reads the object from storage (NOT the request path), verifies the
// real type from bytes, probes intrinsic facts, and marks the asset ready — or failed. Must complete
// before scheduling: an asset still 'uploading'/'processing' is a Phase 5 scheduling BLOCKER (see
// validatePostService), so a post referencing it cannot be scheduled until this finishes.
export async function finalizeUpload(actor: ScopedActor, assetId: string): Promise<{ status: string; reason?: string }> {
  const ctx: TenantContext = { workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role };
  const asset = await withTenant(ctx, (tx) => tx.execute(sql`select id, storage_key, kind from media_assets where id = ${assetId}`))
    .then((r) => rows<{ id: string; storage_key: string; kind: 'image' | 'video' | 'gif' }>(r)[0]);
  if (!asset) throw new MediaError('not_found');

  await withTenant(ctx, (tx) => tx.execute(sql`update media_assets set status = 'processing' where id = ${assetId}`));

  const bytes = await getStorage().getObject(asset.storage_key);

  // Verify the REAL type from the leading bytes — reject anything that isn't a supported media type.
  const sniffed = sniffMimeType(bytes);
  if (!sniffed) return fail(ctx, assetId, 'unrecognized_type');
  const realKind = MIME_TO_KIND[sniffed];
  if (bytes.length > MAX_BYTES[realKind]) return fail(ctx, assetId, 'too_large');

  const probe = await probeAsset(realKind, bytes);
  await withTenant(ctx, (tx) => tx.execute(sql`
    update media_assets set status = 'ready', mime_type = ${sniffed}, kind = ${realKind},
      byte_size = ${probe.bytes}, width = ${probe.width ?? null}, height = ${probe.height ?? null},
      duration_ms = ${probe.durationSec != null ? Math.round(probe.durationSec * 1000) : null},
      codec = ${probe.codec ?? null}, frame_rate = ${probe.frameRate ?? null}
    where id = ${assetId}
  `));
  return { status: 'ready' };
}

async function fail(ctx: TenantContext, assetId: string, reason: string): Promise<{ status: string; reason: string }> {
  await withTenant(ctx, (tx) => tx.execute(sql`update media_assets set status = 'failed' where id = ${assetId}`));
  return { status: 'failed', reason };
}

// --- lifecycle: delete with reference counting + scrub ---
export async function deleteMedia(actor: ScopedActor, assetId: string): Promise<{ scrubbedFrom: number }> {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const asset = rows<{ uploaded_by: string | null; storage_key: string }>(await tx.execute(sql`select uploaded_by, storage_key from media_assets where id = ${assetId}`))[0];
    if (!asset) throw new MediaError('not_found');
    authorize(actor, 'media:delete', { uploadedById: asset.uploaded_by ?? undefined });

    // Reference counting: an asset a LIVE post depends on cannot be deleted. (drizzle spreads the
    // array into `in ($1,$2,...)`, which is the correct shape here.)
    const live = rows(await tx.execute(sql`
      select 1 from posts p
      where p.status::text in ${LIVE_STATES}
        and (
          jsonb_exists(p.content->'media', ${assetId})
          or exists (select 1 from post_targets pt join post_target_overrides o on o.post_target_id = pt.id
                     where pt.post_id = p.id and o.media_override is not null and jsonb_exists(o.media_override, ${assetId}))
        )
      limit 1
    `));
    if (live.length) throw new MediaError('asset_in_use');

    // Scrub the id out of every editable draft that references it (parent content + overrides), using
    // the pure scrubMediaId from Phase 5 — so no dangling reference is left behind.
    let scrubbed = 0;
    const draftPosts = rows<{ id: string; content: { media: string[] } }>(await tx.execute(sql`
      select id, content from posts where status in ('draft','changes_requested') and jsonb_exists(content->'media', ${assetId})
    `));
    for (const p of draftPosts) {
      await tx.execute(sql`update posts set content = ${JSON.stringify(scrubMediaId(p.content, assetId))}::jsonb, updated_at = now() where id = ${p.id}`);
      scrubbed += 1;
    }
    const overrides = rows<{ id: string; media_override: string[] }>(await tx.execute(sql`
      select o.id, o.media_override from post_target_overrides o
      join post_targets pt on pt.id = o.post_target_id
      join posts p on p.id = pt.post_id
      where p.status in ('draft','changes_requested') and o.media_override is not null and jsonb_exists(o.media_override, ${assetId})
    `));
    for (const o of overrides) {
      const next = scrubMediaId({ media: o.media_override }, assetId).media;
      await tx.execute(sql`update post_target_overrides set media_override = ${JSON.stringify(next)}::jsonb, updated_at = now() where id = ${o.id}`);
      scrubbed += 1;
    }

    // Delete variants (storage + rows via cascade) and the source object, then the asset row.
    const variants = rows<{ storage_key: string }>(await tx.execute(sql`select storage_key from media_variants where media_asset_id = ${assetId}`));
    for (const v of variants) await getStorage().deleteObject(v.storage_key).catch(() => undefined);
    await getStorage().deleteObject(asset.storage_key).catch(() => undefined);
    await tx.execute(sql`delete from media_assets where id = ${assetId}`); // cascades media_variants
    await writeAudit(tx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: 'media.deleted', targetType: 'media_asset', targetId: assetId, after: { scrubbedFrom: scrubbed } });
    return { scrubbedFrom: scrubbed };
  });
}

// --- cleanup jobs (maintenance connection; cross-tenant) ---
// Orphans: assets referenced by no post and older than a grace window, or failed uploads.
export async function cleanupOrphans(maint: { transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> }, graceHours = 24): Promise<number> {
  return maint.transaction(async (tx) => {
    const orphans = rows<{ id: string; storage_key: string }>(await tx.execute(sql`
      select a.id, a.storage_key from media_assets a
      where a.created_at < now() - make_interval(hours => ${graceHours})
        and (a.status = 'failed' or not exists (
          select 1 from posts p where p.workspace_id = a.workspace_id and jsonb_exists(p.content->'media', a.id::text)
        ))
      limit 500
    `));
    for (const o of orphans) {
      const variants = rows<{ storage_key: string }>(await tx.execute(sql`select storage_key from media_variants where media_asset_id = ${o.id}`));
      for (const v of variants) await getStorage().deleteObject(v.storage_key).catch(() => undefined);
      await getStorage().deleteObject(o.storage_key).catch(() => undefined);
      await tx.execute(sql`delete from media_assets where id = ${o.id}`);
    }
    return orphans.length;
  });
}
