// src/media/chunked-upload.ts
// Resumable provider upload for large video: a distinct step with its OWN retry, so a video that
// fails at 90% resumes from its last committed offset instead of restarting the whole publish.
//
// The resume point (bytes_uploaded) is committed to media_upload_sessions AFTER EACH CHUNK in its own
// transaction — never inside the publish transaction — so an interruption leaves the progress durable.
import { sql } from 'drizzle-orm';
import { withTenant, type TenantContext } from '../db/tenant';
import type { StorageAdapter } from './storage';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

export interface ProviderChunkBackend {
  initiate(params: { totalBytes: number }): Promise<{ providerUploadId: string }>;
  uploadChunk(params: { providerUploadId: string; offset: number; chunk: Buffer }): Promise<void>;
  finalize(params: { providerUploadId: string }): Promise<{ providerRef: string }>;
}

const CHUNK_SIZE = 4 * 1024 * 1024;

export async function resumableUpload(
  ctx: TenantContext,
  storage: StorageAdapter,
  backend: ProviderChunkBackend,
  params: { postTargetId: string; provider: string; sourceKey: string; chunkSize?: number },
): Promise<{ providerRef: string }> {
  const chunkSize = params.chunkSize ?? CHUNK_SIZE;
  const head = await storage.headObject(params.sourceKey);
  if (!head) throw new Error(`source object missing: ${params.sourceKey}`);
  const total = head.size;

  // Load or create the session (resume if one exists).
  let session = await withTenant(ctx, (tx) => tx.execute(sql`
    select id, provider_upload_id, bytes_uploaded, status, provider_ref
    from media_upload_sessions where post_target_id = ${params.postTargetId} and storage_key = ${params.sourceKey}
  `)).then((r) => rows<{ id: string; provider_upload_id: string; bytes_uploaded: string; status: string; provider_ref: string | null }>(r)[0]);

  if (session?.status === 'completed' && session.provider_ref) return { providerRef: session.provider_ref };

  if (!session) {
    const init = await backend.initiate({ totalBytes: total });
    session = await withTenant(ctx, (tx) => tx.execute(sql`
      insert into media_upload_sessions (workspace_id, post_target_id, provider, storage_key, provider_upload_id, total_bytes, bytes_uploaded, status)
      values (${ctx.workspaceId}, ${params.postTargetId}, ${params.provider}, ${params.sourceKey}, ${init.providerUploadId}, ${total}, 0, 'in_progress')
      returning id, provider_upload_id, bytes_uploaded, status, provider_ref
    `)).then((r) => rows<{ id: string; provider_upload_id: string; bytes_uploaded: string; status: string; provider_ref: string | null }>(r)[0]);
  }

  const providerUploadId = session.provider_upload_id;
  let offset = Number(session.bytes_uploaded); // RESUME POINT

  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    const chunk = await storage.getRange(params.sourceKey, offset, end - 1);
    await backend.uploadChunk({ providerUploadId, offset, chunk }); // may throw (interruption) — offset NOT yet committed
    offset = end;
    // Commit the new resume point in its own transaction so an interruption after this point survives.
    await withTenant(ctx, (tx) => tx.execute(sql`
      update media_upload_sessions set bytes_uploaded = ${offset}, updated_at = now()
      where post_target_id = ${params.postTargetId} and storage_key = ${params.sourceKey}
    `));
  }

  const fin = await backend.finalize({ providerUploadId });
  await withTenant(ctx, (tx) => tx.execute(sql`
    update media_upload_sessions set status = 'completed', provider_ref = ${fin.providerRef}, updated_at = now()
    where post_target_id = ${params.postTargetId} and storage_key = ${params.sourceKey}
  `));
  return { providerRef: fin.providerRef };
}
