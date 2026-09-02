// test/media.test.ts
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant, type TenantContext } from '../src/db/tenant';
import { createWorkspace } from '../src/workspaces/service';
import { sniffMimeType } from '../src/media/sniff';
import { getStorage } from '../src/media/storage';
import { ensureVariant, type VariantRenderer, type VariantSpec } from '../src/media/variants';
import { resumableUpload, type ProviderChunkBackend } from '../src/media/chunked-upload';
import { createUpload, finalizeUpload, deleteMedia, MediaError } from '../src/media/service';
import { validatePost, type ValidateTargetInput } from '../src/posts/validate';
import { createFakeProvider } from '../src/providers/adapters/fake';
import { createDraft, setOverride } from '../src/posts/service';
import { asRows } from './helpers/db';

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
const createUser = async () => asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${`m-${uniq()}@meridian.test`}) returning id`))[0].id;
async function ws() {
  const userId = await createUser();
  const { workspaceId } = await createWorkspace(userId, 'Media');
  // `as const` on role keeps it assignable to both TenantContext (role: string) and ScopedActor (role: Role).
  return { workspaceId, userId, role: 'owner' as const };
}
function pngBuffer(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  b[0] = 0x89; b.write('PNG', 1, 'latin1'); b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

describe('type verification from magic bytes', () => {
  it('sniffs real types and returns null for a spoof', () => {
    expect(sniffMimeType(pngBuffer(10, 10))).toBe('image/png');
    expect(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMimeType(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull(); // 'MZ' — a Windows executable
  });

  it('finalize REJECTS a file whose bytes are not a media type, even if declared image/png', async () => {
    const ctx = await ws();
    const actor = ctx;
    const { assetId, storageKey } = await createUpload(actor, { filename: 'evil.png', declaredType: 'image/png', byteSize: 8 });
    await getStorage().putObject(storageKey, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0, 0, 0, 0]), 'image/png');
    const r = await finalizeUpload(actor, assetId);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('unrecognized_type');
  });

  it('finalize probes a genuine image and marks it ready with real dimensions', async () => {
    const ctx = await ws();
    const actor = ctx;
    const { assetId, storageKey } = await createUpload(actor, { filename: 'photo.png', declaredType: 'image/png', byteSize: 24 });
    await getStorage().putObject(storageKey, pngBuffer(640, 480), 'image/png');
    const r = await finalizeUpload(actor, assetId);
    expect(r.status).toBe('ready');
    const row = asRows<{ status: string; width: number; height: number; mime_type: string }>(await withTenant(ctx, (tx) => tx.execute(sql`select status, width, height, mime_type from media_assets where id = ${assetId}`)))[0];
    expect(row).toMatchObject({ status: 'ready', width: 640, height: 480, mime_type: 'image/png' });
  });
});

describe('validation — unpublishable source', () => {
  const caps = { ...createFakeProvider().adapter.capabilities, provider: 'reels', displayName: 'Reels', permittedAspectRatios: [{ w: 16, h: 9 }], aspectRatioTolerance: 0.02 };
  const target = (over: Partial<ValidateTargetInput>): ValidateTargetInput => ({
    targetId: 't', provider: 'reels', displayName: 'Reels', caps, accountStatus: 'active',
    rendered: { text: '', media: [] }, droppedMedia: [], pendingMedia: 0, duplicateWithinDays: null, ...over,
  });

  it('rejects a portrait video for a landscape network with the right message', () => {
    const res = validatePost({ now: new Date(), schedule: {}, targets: [target({ rendered: { text: '', media: [{ kind: 'video', url: 'k', width: 1080, height: 1920, durationSec: 20 }] } })] });
    const f = res.findings.find((x) => x.code === 'video_wrong_aspect');
    expect(f?.severity).toBe('blocker');
    expect(f?.message).toMatch(/portrait/);
    expect(f?.message).toMatch(/landscape/);
    expect(f?.message).toMatch(/Reels/);
    expect(res.canSchedule).toBe(false);
  });

  it('blocks scheduling while media is still processing', () => {
    const res = validatePost({ now: new Date(), schedule: {}, targets: [target({ pendingMedia: 2 })] });
    expect(res.findings.some((x) => x.code === 'media_processing' && x.severity === 'blocker')).toBe(true);
    expect(res.canSchedule).toBe(false);
  });
});

describe('variant caching', () => {
  it('generates a rendition once, then serves it from cache', async () => {
    const ctx = await ws();
    const assetId = asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`
      insert into media_assets (workspace_id, kind, storage_key, mime_type, status) values (${ctx.workspaceId}, 'image', ${'src/' + uniq()}, 'image/png', 'ready') returning id`)))[0].id;
    const sourceKey = asRows<{ storage_key: string }>(await withTenant(ctx, (tx) => tx.execute(sql`select storage_key from media_assets where id = ${assetId}`)))[0].storage_key;
    await getStorage().putObject(sourceKey, pngBuffer(1000, 1000), 'image/png');

    let renderCount = 0;
    const renderer: VariantRenderer = { async render(_src, spec) { renderCount += 1; return { bytes: Buffer.from('variant'), width: spec.targetWidth, height: spec.targetHeight, mimeType: spec.mimeType }; } };
    const spec: VariantSpec = { purpose: 'reels:1:1:crop', targetWidth: 500, targetHeight: 500, crop: true, mimeType: 'image/jpeg', isVideo: false };

    const first = await withTenant(ctx, (tx) => ensureVariant(tx, getStorage(), renderer, { assetId, workspaceId: ctx.workspaceId, sourceKey, spec }));
    const second = await withTenant(ctx, (tx) => ensureVariant(tx, getStorage(), renderer, { assetId, workspaceId: ctx.workspaceId, sourceKey, spec }));

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.storageKey).toBe(first.storageKey);
    expect(renderCount).toBe(1); // never regenerated
  });
});

describe('resumable provider upload', () => {
  function backend(failAfterCalls?: number) {
    const received: number[] = [];
    let calls = 0;
    const b: ProviderChunkBackend & { received: number[] } = {
      received,
      async initiate() { return { providerUploadId: 'up-1' }; },
      async uploadChunk({ offset }) { calls += 1; if (failAfterCalls && calls > failAfterCalls) throw new Error('interrupted'); received.push(offset); },
      async finalize() { return { providerRef: 'blob-ref' }; },
    };
    return b;
  }

  it('an interrupted chunked upload resumes from the last committed offset', async () => {
    const ctx = await ws();
    const accId = asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone) values (${ctx.workspaceId}, 'x', ${'pa-' + uniq()}, 'UTC') returning id`)))[0].id;
    const targetId = await withTenant(ctx, async (tx) => {
      const post = asRows<{ id: string }>(await tx.execute(sql`insert into posts (workspace_id) values (${ctx.workspaceId}) returning id`))[0];
      return asRows<{ id: string }>(await tx.execute(sql`insert into post_targets (post_id, workspace_id, connected_account_id, state) values (${post.id}, ${ctx.workspaceId}, ${accId}, 'draft') returning id`))[0].id;
    });
    const sourceKey = `video/${uniq()}`;
    await getStorage().putObject(sourceKey, Buffer.from('0123456789'), 'video/mp4'); // 10 bytes, chunk 3 => 4 chunks

    const b1 = backend(2); // fails on the 3rd chunk
    await expect(resumableUpload(ctx, getStorage(), b1, { postTargetId: targetId, provider: 'x', sourceKey, chunkSize: 3 })).rejects.toThrow('interrupted');
    expect(b1.received).toEqual([0, 3]); // only two chunks made it before the interruption
    const committed = asRows<{ bytes_uploaded: string }>(await withTenant(ctx, (tx) => tx.execute(sql`select bytes_uploaded from media_upload_sessions where post_target_id = ${targetId} and storage_key = ${sourceKey}`)))[0];
    expect(Number(committed.bytes_uploaded)).toBe(6);

    const b2 = backend(); // recovers
    const res = await resumableUpload(ctx, getStorage(), b2, { postTargetId: targetId, provider: 'x', sourceKey, chunkSize: 3 });
    expect(res.providerRef).toBe('blob-ref');
    expect(b2.received[0]).toBe(6); // RESUMED from 6, did not restart at 0
    expect(b2.received).toEqual([6, 9]);
  });
});

describe('media lifecycle', () => {
  it('deleting an asset referenced by an override leaves no dangling reference', async () => {
    const ctx = await ws();
    const actor = ctx;
    const accId = asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone) values (${ctx.workspaceId}, 'x', ${'pa-' + uniq()}, 'UTC') returning id`)))[0].id;
    const assetId = asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`insert into media_assets (workspace_id, uploaded_by, kind, storage_key, mime_type, status) values (${ctx.workspaceId}, ${ctx.userId}, 'image', ${'src/' + uniq()}, 'image/png', 'ready') returning id`)))[0].id;

    const { postId } = await createDraft(actor, { content: { text: 'hi', media: [] }, targetAccountIds: [accId] });
    const targetId = asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`select id from post_targets where post_id = ${postId}`)))[0].id;
    await setOverride(actor, postId, targetId, { media: [assetId] });

    await deleteMedia(actor, assetId);

    const ov = asRows<{ media_override: string[] | null }>(await withTenant(ctx, (tx) => tx.execute(sql`select media_override from post_target_overrides where post_target_id = ${targetId}`)))[0];
    expect(ov.media_override).toEqual([]); // scrubbed — the deleted id is gone
    expect((ov.media_override ?? []).includes(assetId)).toBe(false);
    expect(asRows(await withTenant(ctx, (tx) => tx.execute(sql`select id from media_assets where id = ${assetId}`)))).toHaveLength(0);
  });

  it('refuses to delete an asset a scheduled post depends on', async () => {
    const ctx = await ws();
    const actor = ctx;
    const accId = asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone) values (${ctx.workspaceId}, 'x', ${'pa-' + uniq()}, 'UTC') returning id`)))[0].id;
    const assetId = asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`insert into media_assets (workspace_id, uploaded_by, kind, storage_key, mime_type, status) values (${ctx.workspaceId}, ${ctx.userId}, 'image', ${'src/' + uniq()}, 'image/png', 'ready') returning id`)))[0].id;
    const { postId } = await createDraft(actor, { content: { text: 'hi', media: [assetId] }, targetAccountIds: [accId] });
    await withTenant(ctx, (tx) => tx.execute(sql`update posts set status = 'scheduled' where id = ${postId}`));

    await expect(deleteMedia(actor, assetId)).rejects.toBeInstanceOf(MediaError);
    expect(asRows(await withTenant(ctx, (tx) => tx.execute(sql`select id from media_assets where id = ${assetId}`)))).toHaveLength(1); // still there
  });
});
