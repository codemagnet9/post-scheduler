// src/webhooks/service.ts
// Webhook endpoint management. The signing secret is generated once, shown once, and stored ENCRYPTED
// (vault keyring, same as OAuth tokens) — never in plaintext. Subscriptions are an explicit event-type
// allowlist; a delivery is created only for a subscribed event.
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenant, type TenantContext } from '../db/tenant';
import { encrypt, decrypt } from '../vault/crypto';
import { writeAudit } from '../audit/audit';
import { ApiError } from '../api/errors';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

// The event types a customer may subscribe to (the public, stable subset of our internal event bus).
export const WEBHOOK_EVENTS = [
  'post_target.published',
  'post_target.failed',
  'post_target.needs_review',
  'post.scheduled',
  'post.approved',
  'connected_account.auth_expired',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

function validateEvents(events: unknown): WebhookEvent[] {
  const arr = Array.isArray(events) ? events : [];
  const out = (WEBHOOK_EVENTS as readonly string[]).filter((e) => arr.includes(e)) as WebhookEvent[];
  if (!out.length) throw new ApiError('validation_error', `Subscribe to at least one event: ${WEBHOOK_EVENTS.join(', ')}`);
  return out;
}
function validateUrl(url: unknown): string {
  if (typeof url !== 'string') throw new ApiError('validation_error', 'A webhook url is required.');
  let u: URL;
  try { u = new URL(url); } catch { throw new ApiError('validation_error', 'Webhook url is not a valid URL.'); }
  if (u.protocol !== 'https:') throw new ApiError('validation_error', 'Webhook url must be https.');
  return url;
}

export interface RegisteredWebhook { id: string; url: string; events: WebhookEvent[]; secret: string }

export async function registerWebhook(ctx: TenantContext, input: { url: string; events: WebhookEvent[] }): Promise<RegisteredWebhook> {
  const url = validateUrl(input.url);
  const events = validateEvents(input.events);
  // whsec_<random>: shown ONCE, stored encrypted.
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const { ciphertext, keyId } = encrypt(secret);
  return withTenant(ctx, async (tx) => {
    const r = rows<{ id: string }>(await tx.execute(sql`
      insert into webhook_endpoints (workspace_id, url, secret_ciphertext, key_id, subscribed_events, created_by)
      values (${ctx.workspaceId}, ${url}, ${ciphertext}, ${keyId}, ${JSON.stringify(events)}::jsonb, ${sentinelNull(ctx.userId)})
      returning id`))[0];
    await writeAudit(tx, { workspaceId: ctx.workspaceId, actorUserId: sentinelNull(ctx.userId), action: 'webhook.created', targetType: 'webhook_endpoint', targetId: r.id });
    return { id: r.id, url, events, secret };
  });
}

export async function listWebhooks(ctx: TenantContext): Promise<unknown[]> {
  return withTenant(ctx, (tx) => tx.execute(sql`
    select id, url, subscribed_events, active, disabled_reason, disabled_at, created_at
    from webhook_endpoints order by created_at desc`)).then(rows);
}

export async function deleteWebhook(ctx: TenantContext, id: string): Promise<{ deleted: boolean }> {
  return withTenant(ctx, async (tx) => {
    const r = rows(await tx.execute(sql`delete from webhook_endpoints where id = ${id} returning id`));
    if (!r.length) throw new ApiError('not_found', 'No such webhook endpoint.');
    return { deleted: true };
  });
}

// The customer-visible delivery log (cursor-paginated by the route). Every attempt's outcome is here.
export async function listDeliveries(ctx: TenantContext, endpointId: string, opts: { limit: number; cursor: { createdAt: string; id: string } | null }): Promise<Row[]> {
  return withTenant(ctx, (tx) => tx.execute(sql`
    select d.id, d.event_id, e.type as event_type, d.status, d.attempt_count, d.response_status,
           d.response_body_snippet, d.next_attempt_at, d.delivered_at, d.created_at
    from webhook_deliveries d join events e on e.id = d.event_id
    where d.endpoint_id = ${endpointId}
      ${opts.cursor ? sql`and (d.created_at, d.id) < (${opts.cursor.createdAt}, ${opts.cursor.id})` : sql``}
    order by d.created_at desc, d.id desc
    limit ${opts.limit + 1}`)).then(rows);
}

// Manual replay: re-arm a delivery (pending, now) so the delivery worker re-sends it. Re-enables the
// endpoint if it had been auto-disabled (the customer fixed their side and is retrying).
export async function replayDelivery(ctx: TenantContext, endpointId: string, deliveryId: string): Promise<{ replayed: boolean }> {
  return withTenant(ctx, async (tx) => {
    const d = rows(await tx.execute(sql`
      update webhook_deliveries set status = 'pending', next_attempt_at = now()
      where id = ${deliveryId} and endpoint_id = ${endpointId} returning id`));
    if (!d.length) throw new ApiError('not_found', 'No such delivery for this endpoint.');
    await tx.execute(sql`update webhook_endpoints set active = true, disabled_reason = null, disabled_at = null where id = ${endpointId}`);
    return { replayed: true };
  });
}

// Test/ops helper: reveal the endpoint's secret from ciphertext (never sent over the API).
export async function decryptSecret(ctx: TenantContext, endpointId: string): Promise<string> {
  const r = rows<{ secret_ciphertext: Buffer; key_id: string }>(await withTenant(ctx, (tx) =>
    tx.execute(sql`select secret_ciphertext, key_id from webhook_endpoints where id = ${endpointId}`)))[0];
  if (!r) throw new ApiError('not_found', 'No such webhook endpoint.');
  return decrypt(bufOf(r.secret_ciphertext), r.key_id);
}

// postgres-js returns bytea as a Buffer already, but be defensive across drivers.
function bufOf(v: unknown): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array);
}
const SYSTEM = '00000000-0000-0000-0000-000000000000';
const sentinelNull = (u: string | null): string | null => (u && u !== SYSTEM ? u : null);

export const _fingerprintForTest = (s: string): string => createHash('sha256').update(s).digest('hex');
