// test/public-api.test.ts
// Phase 10 public API + webhooks. The six contractual guarantees, tested from the HTTP surface where
// they live, plus the webhook signing procedure exactly as a customer would run it.
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant, type TenantContext } from '../src/db/tenant';
import { buildServer } from '../src/server';
import { createWorkspace } from '../src/workspaces/service';
import { createApiKey, revokeApiKey } from '../src/api/keys';
import { createFakeProvider } from '../src/providers/adapters/fake';
import { registerAdapter } from '../src/providers/registry';
import { emitEvent } from '../src/events/emit';
import { registerWebhook, decryptSecret } from '../src/webhooks/service';
import { fanOutTick, deliverTick, type Sender } from '../src/webhooks/dispatcher';
import { sign, verify } from '../src/webhooks/signing';
import { asRows, adminDb } from './helpers/db';

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

async function createUser(): Promise<string> {
  return asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${`v1-${uniq()}@meridian.test`}) returning id`))[0].id;
}

interface Fixture { ctx: TenantContext; workspaceId: string; accountId: string; provider: string }
async function makeWorkspaceWithAccount(): Promise<Fixture> {
  const provider = `v1-${uniq()}`;
  registerAdapter(createFakeProvider({ key: provider }).adapter);
  const userId = await createUser();
  const { workspaceId } = await createWorkspace(userId, 'V1');
  const ctx: TenantContext = { workspaceId, userId, role: 'owner' };
  const accountId = await withTenant(ctx, (tx) => tx.execute(sql`
    insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status)
    values (${workspaceId}, ${provider}, ${'pa-' + uniq()}, 'UTC', 'active') returning id`)).then((r) => asRows<{ id: string }>(r)[0].id);
  return { ctx, workspaceId, accountId, provider };
}

// ---------------------------------------------------------------------------
describe('fan-out + idempotency', () => {
  it('one create returns N independently-tracked targets, and an idempotent replay makes no 2nd post', async () => {
    const f = await makeWorkspaceWithAccount();
    const second = await withTenant(f.ctx, (tx) => tx.execute(sql`
      insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status)
      values (${f.workspaceId}, ${f.provider}, ${'pa-' + uniq()}, 'UTC', 'active') returning id`)).then((r) => asRows<{ id: string }>(r)[0].id);
    const { key } = await createApiKey(f.ctx, { name: 'k', scopes: ['read', 'write'] });

    const app = buildServer();
    await app.ready();
    try {
      const bodyStr = JSON.stringify({ account_ids: [f.accountId, second], content: { text: 'fan out' } });
      const headers = { ...bearer(key), 'content-type': 'application/json', 'idempotency-key': 'idem-1' };

      const first = await app.inject({ method: 'POST', url: '/v1/posts', headers, payload: bodyStr });
      expect(first.statusCode).toBe(201);
      const post = first.json();
      expect(post.targets).toHaveLength(2); // the fan-out shape: two independent targets
      expect(new Set(post.targets.map((t: { account_id: string }) => t.account_id))).toEqual(new Set([f.accountId, second]));
      expect(post.targets.every((t: { state: string }) => t.state === 'draft')).toBe(true);

      // Replay: same key + same body -> the SAME response, and NO second post.
      const replay = await app.inject({ method: 'POST', url: '/v1/posts', headers, payload: bodyStr });
      expect(replay.statusCode).toBe(201);
      expect(replay.json().id).toBe(post.id);

      const count = asRows<{ n: string }>(await withTenant(f.ctx, (tx) => tx.execute(sql`select count(*)::int as n from posts`)))[0].n;
      expect(Number(count)).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('same Idempotency-Key with a different body is a 409 conflict', async () => {
    const f = await makeWorkspaceWithAccount();
    const { key } = await createApiKey(f.ctx, { name: 'k', scopes: ['read', 'write'] });
    const app = buildServer();
    await app.ready();
    try {
      const headers = { ...bearer(key), 'content-type': 'application/json', 'idempotency-key': 'idem-2' };
      await app.inject({ method: 'POST', url: '/v1/posts', headers, payload: JSON.stringify({ account_ids: [f.accountId], content: { text: 'a' } }) });
      const conflict = await app.inject({ method: 'POST', url: '/v1/posts', headers, payload: JSON.stringify({ account_ids: [f.accountId], content: { text: 'DIFFERENT' } }) });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe('idempotency_conflict');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('API key auth', () => {
  it('a revoked key is refused immediately', async () => {
    const f = await makeWorkspaceWithAccount();
    const created = await createApiKey(f.ctx, { name: 'k', scopes: ['read', 'write'] });
    const app = buildServer();
    await app.ready();
    try {
      const ok = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(created.key) });
      expect(ok.statusCode).toBe(200);

      await revokeApiKey(f.ctx, created.id);

      const denied = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(created.key) });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error.code).toBe('unauthorized');
    } finally {
      await app.close();
    }
  });

  it('a read-only key cannot write', async () => {
    const f = await makeWorkspaceWithAccount();
    const { key } = await createApiKey(f.ctx, { name: 'ro', scopes: ['read'] });
    const app = buildServer();
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/posts', headers: { ...bearer(key), 'content-type': 'application/json' }, payload: JSON.stringify({ account_ids: [f.accountId] }) });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    } finally {
      await app.close();
    }
  });

  it('enforces the per-key rate limit with the right status and headers', async () => {
    const f = await makeWorkspaceWithAccount();
    const { key } = await createApiKey(f.ctx, { name: 'slow', scopes: ['read'], rateLimitPerMin: 2 });
    const app = buildServer();
    await app.ready();
    try {
      const r1 = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(key) });
      const r2 = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(key) });
      const r3 = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(key) });
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      expect(r3.statusCode).toBe(429);
      expect(r3.json().error.code).toBe('rate_limited');
      expect(r3.headers['x-ratelimit-limit']).toBe('2');
      expect(r3.headers['retry-after']).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('a key from workspace A cannot read workspace B', async () => {
    const a = await makeWorkspaceWithAccount();
    const b = await makeWorkspaceWithAccount();
    const { key: keyA } = await createApiKey(a.ctx, { name: 'a', scopes: ['read', 'write'] });
    // A post that lives in workspace B.
    const bPost = asRows<{ id: string }>(await withTenant(b.ctx, (tx) => tx.execute(sql`insert into posts (workspace_id, status) values (${b.workspaceId}, 'draft') returning id`)))[0].id;

    const app = buildServer();
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/posts/${bPost}`, headers: bearer(keyA) });
      expect(res.statusCode).toBe(404); // RLS makes it invisible -> not_found, never a leak
      expect(res.json().error.code).toBe('not_found');
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('webhook signatures', () => {
  const secret = 'whsec_example';
  const body = JSON.stringify({ id: 'evt_1', type: 'post_target.published' });
  const t = 1_700_000_000;

  it('verifies against the documented procedure', () => {
    const header = sign(secret, t, body);
    expect(verify(secret, header, body, t)).toEqual({ ok: true });
  });
  it('an altered body fails', () => {
    const header = sign(secret, t, body);
    const tampered = verify(secret, header, body + ' ', t);
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.reason).toBe('mismatch');
  });
  it('a replayed old timestamp is rejected', () => {
    const header = sign(secret, t, body);
    const stale = verify(secret, header, body, t + 301); // outside the 300s window
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
describe('webhook fan-out + delivery', () => {
  it('fans a subscribed event out to a delivery, signs it, and the signature verifies', async () => {
    const f = await makeWorkspaceWithAccount();
    const wh = await registerWebhook(f.ctx, { url: 'https://example.test/hook', events: ['post_target.published'] });
    const secret = await decryptSecret(f.ctx, wh.id);
    expect(wh.secret.startsWith('whsec_')).toBe(true);

    // A subscribed event, and one the endpoint did NOT subscribe to.
    const aggId = f.accountId;
    await withTenant(f.ctx, (tx) => emitEvent(tx, { workspaceId: f.workspaceId, aggregateType: 'post_target', aggregateId: aggId, type: 'post_target.published', payload: { permalink: 'https://x/y' } }));
    await withTenant(f.ctx, (tx) => emitEvent(tx, { workspaceId: f.workspaceId, aggregateType: 'post_target', aggregateId: aggId, type: 'post.approved', payload: {} }));

    await fanOutTick(adminDb, { batch: 100_000 }); // drain the whole outbox (many prior-test events precede ours)

    // Exactly one delivery (only the subscribed event fanned out to this endpoint).
    const deliveries = asRows<{ id: string; status: string }>(await withTenant(f.ctx, (tx) => tx.execute(sql`select id, status from webhook_deliveries where endpoint_id = ${wh.id}`)));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('pending');

    // Deliver with a capturing transport; assert the signed request verifies via the documented steps.
    let captured: { url: string; body: string; sig: string } | null = null;
    const now = new Date();
    const send: Sender = async (url, body, headers) => {
      captured = { url, body, sig: headers['meridian-signature'] };
      return { status: 200, text: 'ok' };
    };
    await deliverTick(adminDb, { send, now });

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://example.test/hook');
    expect(verify(secret, captured!.sig, captured!.body, Math.floor(now.getTime() / 1000))).toEqual({ ok: true });

    const after = asRows<{ status: string; response_status: number | null }>(await withTenant(f.ctx, (tx) => tx.execute(sql`select status, response_status from webhook_deliveries where endpoint_id = ${wh.id}`)))[0];
    expect(after.status).toBe('succeeded');
    expect(after.response_status).toBe(200);
  });

  it('a failing delivery is retried, and the endpoint is disabled with a reason after 24h', async () => {
    const f = await makeWorkspaceWithAccount();
    const wh = await registerWebhook(f.ctx, { url: 'https://example.test/broken', events: ['post_target.published'] });
    await withTenant(f.ctx, (tx) => emitEvent(tx, { workspaceId: f.workspaceId, aggregateType: 'post_target', aggregateId: f.accountId, type: 'post_target.published', payload: {} }));
    await fanOutTick(adminDb, { batch: 100_000 }); // drain the whole outbox (many prior-test events precede ours)

    const failing: Sender = async () => ({ status: 500, text: 'nope' });
    // First failure: retried (status 'failed'), endpoint still active.
    await deliverTick(adminDb, { send: failing });
    let d = asRows<{ status: string }>(await withTenant(f.ctx, (tx) => tx.execute(sql`select status from webhook_deliveries where endpoint_id = ${wh.id}`)))[0];
    expect(d.status).toBe('failed');

    // Backdate the delivery past the 24h window, re-arm it, and fail again -> exhausted + endpoint disabled.
    await adminDb.execute(sql`update webhook_deliveries set created_at = now() - interval '25 hours', next_attempt_at = now() where endpoint_id = ${wh.id}`);
    await deliverTick(adminDb, { send: failing });
    d = asRows<{ status: string }>(await withTenant(f.ctx, (tx) => tx.execute(sql`select status from webhook_deliveries where endpoint_id = ${wh.id}`)))[0];
    expect(d.status).toBe('exhausted');

    const ep = asRows<{ active: boolean; disabled_reason: string | null }>(await withTenant(f.ctx, (tx) => tx.execute(sql`select active, disabled_reason from webhook_endpoints where id = ${wh.id}`)))[0];
    expect(ep.active).toBe(false);
    expect(ep.disabled_reason).toContain('24h');
  });
});
