// test/publishing.test.ts
// The exactly-once tests. Integration (Postgres).
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pgArray } from '../src/db/index';
import { withTenant, type TenantContext } from '../src/db/tenant';
import { createWorkspace } from '../src/workspaces/service';
import { storeTokens } from '../src/vault/tokens';
import { createFakeProvider, type FakeControl } from '../src/providers/adapters/fake';
import { registerAdapter } from '../src/providers/registry';
import { claimDueTargets, publishClaimed, leaseSweeperTick, idempotencyKey } from '../src/publishing/pipeline';
import { textFingerprint } from '../src/providers/fingerprint';
import { adminDb, asRows } from './helpers/db';

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;

async function createUser(): Promise<string> {
  return asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${`p-${uniq()}@meridian.test`}) returning id`))[0].id;
}

interface Fixture { ctx: TenantContext; workspaceId: string; accountId: string; providerAccountId: string; provider: string }

async function makeAccount(provider: string): Promise<Fixture> {
  const userId = await createUser();
  const { workspaceId } = await createWorkspace(userId, 'Pub');
  const ctx: TenantContext = { workspaceId, userId, role: 'owner' };
  const providerAccountId = `pa-${uniq()}`;
  const accountId = await withTenant(ctx, async (tx) => {
    const acc = asRows<{ id: string }>(await tx.execute(sql`
      insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status)
      values (${workspaceId}, ${provider}, ${providerAccountId}, 'UTC', 'active') returning id`))[0];
    // Long-lived token (no expiry) so ensureFreshToken never needs to refresh in these tests.
    await storeTokens(tx, { connectedAccountId: acc.id, workspaceId, credentials: { accessToken: 'tok' } });
    return acc.id;
  });
  return { ctx, workspaceId, accountId, providerAccountId, provider };
}

async function dueTarget(f: Fixture, text: string): Promise<{ postId: string; targetId: string }> {
  return withTenant(f.ctx, async (tx) => {
    const post = asRows<{ id: string }>(await tx.execute(sql`insert into posts (workspace_id, status) values (${f.workspaceId}, 'scheduled') returning id`))[0];
    const target = asRows<{ id: string }>(await tx.execute(sql`
      insert into post_targets (post_id, workspace_id, connected_account_id, state, rendered_payload, scheduled_at, publish_due_at)
      values (${post.id}, ${f.workspaceId}, ${f.accountId}, 'scheduled', ${JSON.stringify({ text, media: [] })}::jsonb, now(), now())
      returning id`))[0];
    return { postId: post.id, targetId: target.id };
  });
}

async function claimAndPublish(f: Fixture, workerId: string): Promise<void> {
  const claimed = await withTenant(f.ctx, (tx) => claimDueTargets(tx, { batch: 5, workerId }));
  for (const c of claimed) await publishClaimed(c);
}

const stateOf = (f: Fixture, id: string) =>
  withTenant(f.ctx, (tx) => tx.execute(sql`select state, provider_post_id from post_targets where id = ${id}`)).then((r) => asRows<{ state: string; provider_post_id: string | null }>(r)[0]);

describe('exactly-once under a claim race', () => {
  let f: Fixture;
  let control: FakeControl;
  beforeAll(async () => {
    const provider = `race-${uniq()}`;
    const fake = createFakeProvider({ key: provider });
    control = fake.control;
    registerAdapter(fake.adapter);
    f = await makeAccount(provider);
  });

  it('50 workers race one due target — exactly one publish reaches the provider, 100x', async () => {
    for (let i = 0; i < 100; i += 1) {
      control.mode = { kind: 'ok' };
      control.publishCalls = 0;
      control.store.clear();
      const { targetId } = await dueTarget(f, `race-${i}`);
      await Promise.all(Array.from({ length: 50 }, (_, w) => claimAndPublish(f, `w${w}`)));
      expect(control.publishCalls).toBe(1);
      expect((await stateOf(f, targetId)).state).toBe('published');
    }
  }, 180_000);
});

describe('ambiguous failure — accept then timeout, job redelivered', () => {
  it('a provider that can look up recent posts ends published with the adopted id, one post only', async () => {
    const provider = `amb-lookup-${uniq()}`;
    const fake = createFakeProvider({ key: provider, supportsRecentPostLookup: true, supportsIdempotencyKey: true });
    registerAdapter(fake.adapter);
    const f = await makeAccount(provider);
    fake.control.mode = { kind: 'accept_then_timeout' }; // records the post, then throws

    const { targetId } = await dueTarget(f, 'ambiguous one');
    const claimed = await withTenant(f.ctx, (tx) => claimDueTargets(tx, { batch: 5, workerId: 'w1' }));
    await publishClaimed(claimed[0]); // publishes (records), times out, reconciles via lookup, adopts

    const after = await stateOf(f, targetId);
    expect(after.state).toBe('published');
    expect(after.provider_post_id).toBeTruthy();
    expect(fake.control.publishCalls).toBe(1);

    // Redeliver the SAME job — entry compare-and-set finds it already published and exits.
    await publishClaimed(claimed[0]);
    expect(fake.control.publishCalls).toBe(1); // still one post
  });

  it('a provider with neither idempotency key nor lookup goes to needs_review and is never auto-retried', async () => {
    const provider = `amb-neither-${uniq()}`;
    const fake = createFakeProvider({ key: provider, supportsRecentPostLookup: false, supportsIdempotencyKey: false });
    registerAdapter(fake.adapter);
    const f = await makeAccount(provider);
    fake.control.mode = { kind: 'accept_then_timeout' };

    const { targetId } = await dueTarget(f, 'no recovery possible');
    const claimed = await withTenant(f.ctx, (tx) => claimDueTargets(tx, { batch: 5, workerId: 'w1' }));
    await publishClaimed(claimed[0]);

    expect((await stateOf(f, targetId)).state).toBe('needs_review');
    // The due-scan must NOT pick it up again (it isn't 'scheduled').
    const reclaim = await withTenant(f.ctx, (tx) => claimDueTargets(tx, { batch: 5, workerId: 'w2' }));
    expect(reclaim.find((c) => c.id === targetId)).toBeUndefined();
  });
});

describe('worker killed mid-publish', () => {
  it('the lease expires, the sweeper moves it to reconciling, and reconciliation adopts without a duplicate', async () => {
    const provider = `death-${uniq()}`;
    const fake = createFakeProvider({ key: provider, supportsRecentPostLookup: true });
    registerAdapter(fake.adapter);
    const f = await makeAccount(provider);

    const text = 'worker died here';
    const { targetId } = await dueTarget(f, text);
    // Claim it (now in 'publishing' with a lease) but never publish — the worker "died".
    const claimed = await withTenant(f.ctx, (tx) => claimDueTargets(tx, { batch: 5, workerId: 'doomed' }));
    expect(claimed[0].id).toBe(targetId);
    fake.control.publishCalls = 0;

    // The provider actually created the post (we just never heard). Seed the recentPosts store.
    fake.control.store.set(f.providerAccountId, [{ providerPostId: 'adopted-123', text, fingerprint: textFingerprint(text), createdAt: new Date() }]);
    // Force the lease to have expired.
    await withTenant(f.ctx, (tx) => tx.execute(sql`update post_targets set lease_expires_at = now() - interval '1 minute' where id = ${targetId}`));

    const swept = await leaseSweeperTick(adminDb, { workerId: 'sweeper' });
    expect(swept).toBeGreaterThanOrEqual(1);

    const after = await stateOf(f, targetId);
    expect(after.state).toBe('published');
    expect(after.provider_post_id).toBe('adopted-123'); // adopted, not re-posted
    expect(fake.control.publishCalls).toBe(0);          // publish() was never called during recovery
  });
});

describe('sibling isolation', () => {
  it('one target failing leaves its siblings published and untouched', async () => {
    const okProvider = `sib-ok-${uniq()}`;
    const badProvider = `sib-bad-${uniq()}`;
    const okFake = createFakeProvider({ key: okProvider });
    const badFake = createFakeProvider({ key: badProvider });
    registerAdapter(okFake.adapter);
    registerAdapter(badFake.adapter);
    okFake.control.mode = { kind: 'ok' };
    badFake.control.mode = { kind: 'fail', code: 'content_rejected', reason: 'nope' };

    // One post fanned to two accounts on two providers.
    const userId = await createUser();
    const { workspaceId } = await createWorkspace(userId, 'Siblings');
    const ctx: TenantContext = { workspaceId, userId, role: 'owner' };
    const ids = await withTenant(ctx, async (tx) => {
      const mk = async (provider: string) => {
        const acc = asRows<{ id: string }>(await tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status) values (${workspaceId}, ${provider}, ${`pa-${uniq()}`}, 'UTC', 'active') returning id`))[0];
        await storeTokens(tx, { connectedAccountId: acc.id, workspaceId, credentials: { accessToken: 'tok' } });
        return acc.id;
      };
      const okAcc = await mk(okProvider);
      const badAcc = await mk(badProvider);
      const post = asRows<{ id: string }>(await tx.execute(sql`insert into posts (workspace_id, status) values (${workspaceId}, 'scheduled') returning id`))[0];
      const mkTarget = async (accId: string) => asRows<{ id: string }>(await tx.execute(sql`insert into post_targets (post_id, workspace_id, connected_account_id, state, rendered_payload, scheduled_at, publish_due_at) values (${post.id}, ${workspaceId}, ${accId}, 'scheduled', ${JSON.stringify({ text: 'sib', media: [] })}::jsonb, now(), now()) returning id`))[0].id;
      return { postId: post.id, okTarget: await mkTarget(okAcc), badTarget: await mkTarget(badAcc) };
    });

    const claimed = await withTenant(ctx, (tx) => claimDueTargets(tx, { batch: 10, workerId: 'w1' }));
    for (const c of claimed) await publishClaimed(c);

    const okState = asRows<{ state: string; provider_post_id: string | null }>(await withTenant(ctx, (tx) => tx.execute(sql`select state, provider_post_id from post_targets where id = ${ids.okTarget}`)))[0];
    const badState = asRows<{ state: string }>(await withTenant(ctx, (tx) => tx.execute(sql`select state from post_targets where id = ${ids.badTarget}`)))[0];
    const post = asRows<{ status: string }>(await withTenant(ctx, (tx) => tx.execute(sql`select status from posts where id = ${ids.postId}`)))[0];

    expect(okState.state).toBe('published');
    expect(okState.provider_post_id).toBeTruthy();
    expect(badState.state).toBe('failed');
    expect(post.status).toBe('partially_published');
  });
});

describe('rate-limit recovery', () => {
  it('a rate-limited provider recovers and the queue drains', async () => {
    const provider = `rl-${uniq()}`;
    const fake = createFakeProvider({ key: provider });
    registerAdapter(fake.adapter);
    const f = await makeAccount(provider);

    const targets = [] as string[];
    for (let i = 0; i < 5; i += 1) targets.push((await dueTarget(f, `rl-${i}`)).targetId);

    // First pass: provider rate-limits everything -> each backs off (no thundering herd).
    fake.control.mode = { kind: 'fail', code: 'rate_limited', retryAfterSec: 1 };
    await claimAndPublish(f, 'w1');
    for (const id of targets) {
      const s = await stateOf(f, id);
      expect(s.state).toBe('scheduled'); // requeued, not failed, not published
    }

    // Provider recovers; pull the backoff forward and drain.
    fake.control.mode = { kind: 'ok' };
    await withTenant(f.ctx, (tx) => tx.execute(sql`update post_targets set publish_due_at = now() where post_id in (select post_id from post_targets where id = any(${pgArray(targets)}::uuid[]))`));
    await claimAndPublish(f, 'w2');

    for (const id of targets) expect((await stateOf(f, id)).state).toBe('published');
  });
});

describe('a provider that times out on EVERY attempt', () => {
  it('reaches needs_review in a bounded number of calls, never looping forever', async () => {
    const provider = `always-timeout-${uniq()}`;
    const fake = createFakeProvider({ key: provider, supportsRecentPostLookup: true, supportsIdempotencyKey: false });
    registerAdapter(fake.adapter);
    const f = await makeAccount(provider);
    fake.control.mode = { kind: 'timeout_no_record' }; // sent, never created, recentPosts stays empty

    const { targetId } = await dueTarget(f, 'never lands');
    let iterations = 0;
    let state = 'scheduled';
    while (state !== 'needs_review' && iterations < 12) {
      await claimAndPublish(f, `w${iterations}`); // claim -> publish -> ambiguous -> absent -> requeue
      state = (await stateOf(f, targetId)).state;
      iterations += 1;
    }
    expect(state).toBe('needs_review');
    expect(iterations).toBeLessThanOrEqual(6); // AMBIGUOUS_ATTEMPT_CAP (5) + margin
  });
});

describe('body-level errors are not success', () => {
  it('a 200-with-error-body target does NOT land as published (Fix 2)', async () => {
    const provider = `body-err-${uniq()}`;
    const fake = createFakeProvider({ key: provider, supportsRecentPostLookup: true });
    registerAdapter(fake.adapter);
    const f = await makeAccount(provider);
    fake.control.mode = { kind: 'body_error' }; // classified as content_rejected, nothing recorded

    const { targetId } = await dueTarget(f, 'looked ok but was not');
    await claimAndPublish(f, 'w1');

    const s = await stateOf(f, targetId);
    expect(s.state).not.toBe('published');
    expect(s.state).toBe('failed'); // lookup confirms absence -> genuinely failed
  });
});

describe('a provider that errors AFTER accepting', () => {
  it('is adopted as published, not stranded as failed (Fix 3)', async () => {
    const provider = `reject-after-${uniq()}`;
    const fake = createFakeProvider({ key: provider, supportsRecentPostLookup: true });
    registerAdapter(fake.adapter);
    const f = await makeAccount(provider);
    fake.control.mode = { kind: 'accept_then_reject' }; // records the post, then returns content_rejected

    const { targetId } = await dueTarget(f, 'accepted then 4xx');
    await claimAndPublish(f, 'w1');

    const s = await stateOf(f, targetId);
    expect(s.state).toBe('published');        // the pre-fail lookup found the live post and adopted it
    expect(s.provider_post_id).toBeTruthy();
  });
});

describe('tenancy under the BYPASSRLS maintenance claim', () => {
  it('publishing a workspace-A target never reads or writes workspace-B rows', async () => {
    const provider = `tenant-${uniq()}`;
    const fake = createFakeProvider({ key: provider });
    registerAdapter(fake.adapter);
    fake.control.mode = { kind: 'ok' };

    const a = await makeAccount(provider);
    const b = await makeAccount(provider);
    const at = await dueTarget(a, 'A content');
    const bt = await dueTarget(b, 'B content');

    // Claim ACROSS tenants on the BYPASSRLS maintenance connection, exactly as the worker does.
    const claimed = await adminDb.transaction((tx) => claimDueTargets(tx, { batch: 50, workerId: 'w-maint' }));
    const ca = claimed.find((c) => c.id === at.targetId);
    const cb = claimed.find((c) => c.id === bt.targetId);
    expect(ca?.workspaceId).toBe(a.workspaceId);
    expect(cb?.workspaceId).toBe(b.workspaceId);

    for (const c of claimed) await publishClaimed(c);

    expect((await stateOf(a, at.targetId)).state).toBe('published');
    expect((await stateOf(b, bt.targetId)).state).toBe('published');

    // A's events live only in workspace A; none leaked into B (and vice versa).
    const aEventsInB = asRows(await adminDb.execute(sql`select id from events where aggregate_id = ${at.targetId} and workspace_id = ${b.workspaceId}`));
    const bEventsInA = asRows(await adminDb.execute(sql`select id from events where aggregate_id = ${bt.targetId} and workspace_id = ${a.workspaceId}`));
    expect(aEventsInB).toHaveLength(0);
    expect(bEventsInA).toHaveLength(0);

    // A's publish_attempts row is scoped to workspace A.
    const aAttempt = asRows<{ workspace_id: string }>(await adminDb.execute(sql`select workspace_id from publish_attempts where post_target_id = ${at.targetId}`));
    expect(aAttempt.length).toBeGreaterThan(0);
    expect(aAttempt.every((r) => r.workspace_id === a.workspaceId)).toBe(true);
  });
});
