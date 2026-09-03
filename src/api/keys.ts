// src/api/keys.ts
// API keys are WORKSPACE credentials (not user credentials): they are created by a user but belong to
// the workspace and keep working after that user leaves (api_keys.created_by is ON DELETE SET NULL).
//
// A key is `mrdn_live_<prefix>_<secret>`: the readable `mrdn_live_<prefix>` part is stored and shown
// in the console; the secret is shown ONCE at creation and stored only as a SHA-256 hash. Auth hashes
// the presented key and looks it up — so we can verify without ever holding the plaintext, and
// revocation (revoked_at) takes effect on the very next request because we re-check it every time.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenant, SYSTEM_USER_ID, type TenantContext } from '../db/tenant';
import { maintenanceDb } from '../db/maintenance';
import { authorize, type Actor } from '../authz/abilities';
import { writeAudit } from '../audit/audit';
import { ApiError } from './errors';

export type Scope = 'read' | 'write';
export const ALL_SCOPES: Scope[] = ['read', 'write'];

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
const actorOf = (ctx: TenantContext): Actor => ({ userId: ctx.userId ?? SYSTEM_USER_ID, role: ctx.role as Actor['role'] });

const hashKey = (full: string): string => createHash('sha256').update(full).digest('hex');

function generateKey(): { full: string; prefix: string } {
  const prefix = `mrdn_live_${randomBytes(4).toString('hex')}`; // e.g. mrdn_live_9f3a1b2c
  const secret = randomBytes(24).toString('base64url');          // 32 url-safe chars
  return { full: `${prefix}_${secret}`, prefix };
}

function normalizeScopes(scopes: unknown): Scope[] {
  const arr = Array.isArray(scopes) ? scopes : [];
  const out = ALL_SCOPES.filter((s) => arr.includes(s));
  if (!out.length) throw new ApiError('validation_error', 'At least one scope (read, write) is required.');
  return out;
}

export interface CreatedKey { id: string; key: string; keyPrefix: string; scopes: Scope[]; rateLimitPerMin: number }

// Console (session) operation. Owner-only via api_key:create.
export async function createApiKey(ctx: TenantContext, input: { name: string; scopes: Scope[]; rateLimitPerMin?: number }): Promise<CreatedKey> {
  return withTenant(ctx, async (tx) => {
    authorize(actorOf(ctx), 'api_key:create');
    const scopes = normalizeScopes(input.scopes);
    if (!input.name?.trim()) throw new ApiError('validation_error', 'A key name is required.');
    const rateLimit = input.rateLimitPerMin ?? 120;
    const { full, prefix } = generateKey();
    const r = rows<{ id: string }>(await tx.execute(sql`
      insert into api_keys (workspace_id, name, key_prefix, key_hash, scopes, created_by, rate_limit_per_min)
      values (${ctx.workspaceId}, ${input.name.trim()}, ${prefix}, ${hashKey(full)}, ${JSON.stringify(scopes)}::jsonb, ${ctx.userId}, ${rateLimit})
      returning id`))[0];
    await writeAudit(tx, { workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: 'api_key.created', targetType: 'api_key', targetId: r.id });
    // The plaintext key is returned ONCE here and never again.
    return { id: r.id, key: full, keyPrefix: prefix, scopes, rateLimitPerMin: rateLimit };
  });
}

export async function listApiKeys(ctx: TenantContext): Promise<unknown[]> {
  return withTenant(ctx, async (tx) => {
    authorize(actorOf(ctx), 'api_key:view');
    return rows(await tx.execute(sql`
      select id, name, key_prefix, scopes, rate_limit_per_min, request_count, last_used_at, created_at, revoked_at, expires_at
      from api_keys order by created_at desc`));
  });
}

// Revocation is immediate: authenticateApiKey re-reads revoked_at on every request.
export async function revokeApiKey(ctx: TenantContext, id: string): Promise<{ revoked: boolean }> {
  return withTenant(ctx, async (tx) => {
    authorize(actorOf(ctx), 'api_key:revoke');
    const r = rows(await tx.execute(sql`update api_keys set revoked_at = now() where id = ${id} and revoked_at is null returning id`));
    if (!r.length) throw new ApiError('not_found', 'No such API key.');
    await writeAudit(tx, { workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: 'api_key.revoked', targetType: 'api_key', targetId: id });
    return { revoked: true };
  });
}

export interface AuthenticatedKey { workspaceId: string; keyId: string; scopes: Scope[]; createdBy: string | null; rateLimitPerMin: number }

// The public-API auth lookup. It has no tenant context yet, so it reads via the maintenance
// connection (bypasses RLS) BY HASH — the only cross-tenant read, tightly scoped to key resolution.
export async function authenticateApiKey(presented: string): Promise<AuthenticatedKey> {
  const token = presented.trim();
  if (!token.startsWith('mrdn_live_')) throw new ApiError('unauthorized', 'Invalid API key.');
  const r = rows<{ id: string; workspace_id: string; scopes: Scope[]; created_by: string | null; rate_limit_per_min: number; key_hash: string; revoked_at: string | null; expires_at: string | null }>(
    await maintenanceDb.execute(sql`
      select id, workspace_id, scopes, created_by, rate_limit_per_min, key_hash, revoked_at, expires_at
      from api_keys where key_hash = ${hashKey(token)}`),
  )[0];
  // Constant-time-ish: the hash lookup already gates on equality; the timingSafeEqual guards against a
  // theoretical partial-hash oracle and keeps the not-found path indistinguishable in shape.
  if (!r || !safeEqualHex(r.key_hash, hashKey(token))) throw new ApiError('unauthorized', 'Invalid API key.');
  if (r.revoked_at) throw new ApiError('unauthorized', 'This API key has been revoked.');
  if (r.expires_at && new Date(r.expires_at).getTime() <= Date.now()) throw new ApiError('unauthorized', 'This API key has expired.');
  return { workspaceId: r.workspace_id, keyId: r.id, scopes: r.scopes ?? [], createdBy: r.created_by, rateLimitPerMin: r.rate_limit_per_min };
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Best-effort usage accounting after a successful auth (never blocks the request).
export async function recordKeyUsage(keyId: string): Promise<void> {
  await maintenanceDb.execute(sql`update api_keys set last_used_at = now(), request_count = request_count + 1 where id = ${keyId}`).catch(() => undefined);
}

// The API key acts for its workspace with role 'owner' at the SERVICE layer; the read/write split is
// enforced by SCOPE at the /v1 boundary, which is the real authorization gate for keys.
export function keyContext(key: AuthenticatedKey): TenantContext {
  return { workspaceId: key.workspaceId, userId: key.createdBy, role: 'owner' };
}
