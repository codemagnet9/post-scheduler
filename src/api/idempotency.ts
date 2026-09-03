// src/api/idempotency.ts
// Idempotency for every /v1 write. The client sends `Idempotency-Key: <opaque>`; we key on
// (workspace_id, idempotency_key) — the Phase 1 UNIQUE constraint — plus a fingerprint of the request
// so the SAME key with a DIFFERENT body is a conflict, not a silent wrong replay.
//
// Lifecycle: the FIRST request inserts a row (status='in_progress'), runs the handler, then stores the
// response (status='completed'). A retry with the same key+body returns the stored response verbatim —
// so a network retry of "create post" never creates a second post. A retry while the first is still
// in flight returns 409 idempotency_in_progress (the caller retries shortly).
//
// RETENTION: records live 24 hours (expires_at), then a cron GCs them. After that window a reused key
// is treated as new — documented so integrators don't rely on infinite dedupe.
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenant, type TenantContext } from '../db/tenant';
import { ApiError } from './errors';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

export const IDEMPOTENCY_RETENTION_HOURS = 24;

// Stable fingerprint of the write: method + path + canonical(body). Canonicalization sorts object
// keys so `{a,b}` and `{b,a}` are the same request, not a false conflict.
function fingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method} ${path}\n${canonical(body)}`).digest('hex');
}
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

export interface StoredResponse { status: number; body: unknown }

// Wraps a write. If `key` is absent, runs the handler with no dedupe. Otherwise enforces the contract
// above and returns { status, body } — the caller sends exactly that.
export async function withIdempotency(
  ctx: TenantContext,
  key: string | undefined,
  req: { method: string; path: string; body: unknown },
  handler: () => Promise<StoredResponse>,
): Promise<StoredResponse> {
  if (!key) return handler();
  const fp = fingerprint(req.method, req.path, req.body);

  // Try to claim the key. ON CONFLICT DO NOTHING means: inserted => we're first; empty => it exists.
  const claimed = await withTenant(ctx, (tx) => tx.execute(sql`
    insert into api_idempotency_keys (workspace_id, idempotency_key, request_fingerprint, status, expires_at)
    values (${ctx.workspaceId}, ${key}, ${fp}, 'in_progress', now() + make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS}))
    on conflict (workspace_id, idempotency_key) do nothing
    returning id
  `)).then(rows);

  if (!claimed.length) {
    // The key already exists. Load it and decide: replay, conflict, or still-running.
    const existing = rows<{ request_fingerprint: string; status: string; response_status: number | null; response_body: unknown }>(
      await withTenant(ctx, (tx) => tx.execute(sql`
        select request_fingerprint, status, response_status, response_body
        from api_idempotency_keys where idempotency_key = ${key}`)),
    )[0];
    if (!existing) return handler(); // raced with GC; extremely unlikely — just run it
    if (existing.request_fingerprint !== fp) {
      throw new ApiError('idempotency_conflict', 'This Idempotency-Key was already used with a different request body.');
    }
    if (existing.status !== 'completed' || existing.response_status === null) {
      throw new ApiError('idempotency_in_progress', 'A request with this Idempotency-Key is still being processed. Retry shortly.');
    }
    return { status: existing.response_status, body: existing.response_body };
  }

  // We own the key: run the handler, then persist its response so retries replay it.
  try {
    const result = await handler();
    await withTenant(ctx, (tx) => tx.execute(sql`
      update api_idempotency_keys set status = 'completed', response_status = ${result.status}, response_body = ${JSON.stringify(result.body)}::jsonb
      where idempotency_key = ${key}`));
    return result;
  } catch (err) {
    // A failed handler must not poison the key — delete the claim so the client can retry cleanly.
    await withTenant(ctx, (tx) => tx.execute(sql`delete from api_idempotency_keys where idempotency_key = ${key} and status = 'in_progress'`)).catch(() => undefined);
    throw err;
  }
}

// Cron: purge expired idempotency records (bounded so one tick can't lock the table).
export async function gcIdempotencyKeys(maint: { execute: (q: unknown) => Promise<unknown> }, batch = 5000): Promise<number> {
  const r = rows(await maint.execute(sql`
    delete from api_idempotency_keys where id in (
      select id from api_idempotency_keys where expires_at <= now() limit ${batch}
    ) returning id`));
  return r.length;
}
