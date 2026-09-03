// test/hardening.test.ts
// The five highest-value tests that did NOT exist before Phase 11 (honest gaps in prior coverage):
//   1. cross-tenant WRITE is blocked (only READ isolation was proven before)
//   2. idempotency holds under a true concurrent race (only sequential replay was tested)
//   3. auth login is rate-limited (a core account-security control with no test)
//   4. the cross-phase golden path: draft -> schedule -> publish -> snapshot -> analytics
//   5. the observability metrics actually reflect a broken state (dead letters, stuck targets, success rate)
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant, type TenantContext } from '../src/db/tenant';
import { buildServer } from '../src/server';
import { createWorkspace } from '../src/workspaces/service';
import { createApiKey } from '../src/api/keys';
import { hashPassword } from '../src/auth/password';
import { login, AuthError } from '../src/auth/service';
import { RateLimitedError } from '../src/auth/rate-limit';
import { storeTokens } from '../src/vault/tokens';
import { createFakeProvider } from '../src/providers/adapters/fake';
import { registerAdapter } from '../src/providers/registry';
import { createDraft, setSchedule } from '../src/posts/service';
import { schedulePost } from '../src/scheduling/schedule';
import { claimDueTargets, publishClaimed } from '../src/publishing/pipeline';
import { metricsSnapshotTick } from '../src/analytics/ingest';
import { headline } from '../src/analytics/read-models';
import { collectMetrics } from '../src/obs/metrics';
import { adminDb, asRows } from './helpers/db';

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
const createUser = async () => asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${`h-${uniq()}@meridian.test`}) returning id`))[0].id;

// --- 1. cross-tenant WRITE is blocked ---------------------------------------
describe('tenant write isolation', () => {
  it('a member of A cannot insert into, or update, workspace B (RLS WITH CHECK + invisibility)', async () => {
    const ua = await createUser();
    const ub = await createUser();
    const { workspaceId: wsA } = await createWorkspace(ua, 'A');
    const { workspaceId: wsB } = await createWorkspace(ub, 'B');
    const bPost = asRows<{ id: string }>(await withTenant({ workspaceId: wsB, userId: ub, role: 'owner' }, (tx) => tx.execute(sql`insert into posts (workspace_id, author_id) values (${wsB}, ${ub}) returning id`)))[0].id;

    // INSERT a row tagged with B's workspace_id from A's context -> WITH CHECK rejects it.
    await expect(withTenant({ workspaceId: wsA, userId: ua, role: 'owner' }, (tx) =>
      tx.execute(sql`insert into posts (workspace_id, author_id) values (${wsB}, ${ua})`),
    )).rejects.toThrow(/row-level security|policy/i);

    // UPDATE B's post from A's context -> the row is invisible, so it affects nothing.
    const updated = asRows(await withTenant({ workspaceId: wsA, userId: ua, role: 'owner' }, (tx) =>
      tx.execute(sql`update posts set status = 'draft' where id = ${bPost} returning id`)));
    expect(updated).toHaveLength(0);

    // ...and B's post is untouched.
    const still = asRows<{ status: string }>(await withTenant({ workspaceId: wsB, userId: ub, role: 'owner' }, (tx) => tx.execute(sql`select status from posts where id = ${bPost}`)))[0];
    expect(still.status).toBe('draft'); // unchanged default, never mutated by A
  });
});

// --- 2. idempotency under a concurrent race ---------------------------------
describe('idempotency under concurrency', () => {
  it('two simultaneous identical writes create exactly ONE post', async () => {
    const provider = `hard-${uniq()}`;
    registerAdapter(createFakeProvider({ key: provider }).adapter);
    const u = await createUser();
    const { workspaceId } = await createWorkspace(u, 'Idem');
    const ctx: TenantContext = { workspaceId, userId: u, role: 'owner' };
    const accId = asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status) values (${workspaceId}, ${provider}, ${'pa-' + uniq()}, 'UTC', 'active') returning id`)))[0].id;
    const { key } = await createApiKey(ctx, { name: 'k', scopes: ['read', 'write'] });

    const app = buildServer();
    await app.ready();
    try {
      const req = { method: 'POST' as const, url: '/v1/posts', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'race-1' }, payload: JSON.stringify({ account_ids: [accId], content: { text: 'race' } }) };
      const [a, b] = await Promise.all([app.inject(req), app.inject(req)]); // fired together

      // Never two posts, whatever the interleaving.
      const count = Number(asRows<{ n: string }>(await withTenant(ctx, (tx) => tx.execute(sql`select count(*)::int as n from posts`)))[0].n);
      expect(count).toBe(1);
      // Each response is either the created post (201) or the in-progress guard (409) — never a 500.
      for (const r of [a, b]) expect([201, 409]).toContain(r.statusCode);
      expect([a, b].some((r) => r.statusCode === 201)).toBe(true);
    } finally {
      await app.close();
    }
  });
});

// --- 3. auth login rate limiting --------------------------------------------
describe('auth rate limiting', () => {
  it('throttles after the per-account attempt limit (5 / 15 min)', async () => {
    const email = `rl-${uniq()}@meridian.test`;
    await db.execute(sql`insert into users (email, password_hash, email_verified_at) values (${email}, ${await hashPassword('correct-horse')}, now())`);
    // Five wrong-password attempts are allowed (each an auth failure)...
    for (let i = 0; i < 5; i += 1) {
      await expect(login({ email, password: 'wrong' }, {})).rejects.toBeInstanceOf(AuthError);
    }
    // ...the sixth is refused by the rate limiter BEFORE the password is even checked.
    await expect(login({ email, password: 'wrong' }, {})).rejects.toBeInstanceOf(RateLimitedError);
    // And a correct password is still refused while the window is hot (limit protects the account).
    await expect(login({ email, password: 'correct-horse' }, {})).rejects.toBeInstanceOf(RateLimitedError);
  });
});

// --- 4. the cross-phase golden path -----------------------------------------
describe('golden path (draft -> schedule -> publish -> snapshot -> analytics)', () => {
  it('a post published through the real pipeline shows up in the analytics headline', async () => {
    const provider = `gold-${uniq()}`;
    const fake = createFakeProvider({ key: provider });
    fake.control.metrics = { impressions: 100, reach: 80, engagements: 13, clicks: 5, saves: 2, shares: 1 };
    registerAdapter(fake.adapter);
    const u = await createUser();
    const { workspaceId } = await createWorkspace(u, 'Gold');
    const ctx = { workspaceId, userId: u, role: 'owner' as const };
    const accId = await withTenant(ctx, async (tx) => {
      const id = asRows<{ id: string }>(await tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status) values (${workspaceId}, ${provider}, ${'pa-' + uniq()}, 'UTC', 'active') returning id`))[0].id;
      await storeTokens(tx, { connectedAccountId: id, workspaceId, credentials: { accessToken: 'tok' } });
      return id;
    });

    // Phase 5: draft. Phase 6: schedule (future, then pull it due).
    const { postId } = await createDraft(ctx, { content: { text: 'golden path', media: [] }, targetAccountIds: [accId] });
    await setSchedule(ctx, postId, { type: 'fixed_instant', scheduledAt: new Date(Date.now() + 120_000).toISOString() });
    await schedulePost(ctx, postId);
    await withTenant(ctx, (tx) => tx.execute(sql`update post_targets set publish_due_at = now() where post_id = ${postId}`));

    // Phase 6: claim + publish through the exactly-once core.
    const claimed = await withTenant(ctx, (tx) => claimDueTargets(tx, { batch: 5, workerId: 'gold' }));
    for (const c of claimed) await publishClaimed(c);
    const target = asRows<{ state: string; provider_post_id: string | null }>(await withTenant(ctx, (tx) => tx.execute(sql`select state, provider_post_id from post_targets where post_id = ${postId}`)))[0];
    expect(target.state).toBe('published');
    expect(target.provider_post_id).toBeTruthy();

    // Phase 9: the publish set metrics_next_at (+1h); make it due, run the snapshot worker.
    await withTenant(ctx, (tx) => tx.execute(sql`update post_targets set metrics_next_at = now() - interval '1 minute' where post_id = ${postId}`));
    await metricsSnapshotTick(adminDb);

    // Phase 9 read model: the headline reflects the fake provider's metrics.
    const h = await headline(ctx, { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) });
    expect(h.impressions.value).toBe(100);
    expect(h.engagements.value).toBe(13);
  });
});

// --- 5. observability metrics reflect a broken state ------------------------
describe('observability metrics', () => {
  it('surfaces per-provider success rate, dead letters and stuck-in-flight targets', async () => {
    const provider = `obs-${uniq()}`;
    const u = await createUser();
    const { workspaceId } = await createWorkspace(u, 'Obs');
    const ctx: TenantContext = { workspaceId, userId: u, role: 'owner' };

    const before = await collectMetrics(adminDb);

    // Three accounts on the SAME provider (targets are unique per post+account).
    const acct = async () => asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status) values (${workspaceId}, ${provider}, ${'pa-' + uniq()}, 'UTC', 'active') returning id`)))[0].id;
    const [a1, a2, a3] = [await acct(), await acct(), await acct()];
    const post = asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`insert into posts (workspace_id, author_id, status) values (${workspaceId}, ${u}, 'published') returning id`)))[0].id;

    // One published + one failed for this unique provider => success rate exactly 0.5.
    await withTenant(ctx, (tx) => tx.execute(sql`insert into post_targets (post_id, workspace_id, connected_account_id, state, published_at) values (${post}, ${workspaceId}, ${a1}, 'published', now())`));
    const failId = asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`insert into post_targets (post_id, workspace_id, connected_account_id, state, failure_code) values (${post}, ${workspaceId}, ${a2}, 'failed', 'content_rejected') returning id`)))[0].id;
    // A stuck target: publishing with an expired lease (sweeper would be behind).
    await withTenant(ctx, (tx) => tx.execute(sql`insert into post_targets (post_id, workspace_id, connected_account_id, state, lease_expires_at) values (${post}, ${workspaceId}, ${a3}, 'publishing', now() - interval '5 minutes')`));
    // A dead letter.
    await withTenant(ctx, (tx) => tx.execute(sql`insert into dead_letters (workspace_id, post_target_id, reason) values (${workspaceId}, ${failId}, 'content_rejected') on conflict do nothing`));

    const after = await collectMetrics(adminDb);
    const mine = after.publishByProvider.find((p) => p.provider === provider);
    expect(mine).toBeDefined();
    expect(mine!.published).toBe(1);
    expect(mine!.failed).toBe(1);
    expect(mine!.successRate).toBe(0.5);
    expect(after.deadLetters).toBe(before.deadLetters + 1);
    expect(after.stuckInFlight).toBe(before.stuckInFlight + 1);
  });
});
