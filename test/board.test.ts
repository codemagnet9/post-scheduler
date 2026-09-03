// test/board.test.ts
// Calendar/Queue board (Frontend Phase 3 backend): a reschedule the server refuses is atomic (the move
// does not stick) and carries a reason; a failed target retries INDEPENDENTLY of its siblings.
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant } from '../src/db/tenant';
import { createWorkspace } from '../src/workspaces/service';
import * as board from '../src/scheduling/board';
import { asRows } from './helpers/db';

type Ctx = { workspaceId: string; userId: string; role: 'owner' };
let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function seed(): Promise<{ ctx: Ctx; accountId: string }> {
  const userId = asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${`b-${uniq()}@meridian.test`}) returning id`))[0].id;
  const { workspaceId } = await createWorkspace(userId, 'Board');
  const ctx: Ctx = { workspaceId, userId, role: 'owner' };
  const accountId = await withTenant(ctx, (tx) => tx.execute(sql`
    insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status)
    values (${workspaceId}, 'x', ${'pa-' + uniq()}, 'UTC', 'active') returning id`)).then((r) => asRows<{ id: string }>(r)[0].id);
  return { ctx, accountId };
}

async function scheduledTarget(ctx: Ctx, accountId: string, state = 'scheduled'): Promise<{ postId: string; targetId: string }> {
  return withTenant(ctx, async (tx) => {
    const post = asRows<{ id: string }>(await tx.execute(sql`insert into posts (workspace_id, author_id, status) values (${ctx.workspaceId}, ${ctx.userId}, 'scheduled') returning id`))[0];
    const t = asRows<{ id: string }>(await tx.execute(sql`
      insert into post_targets (post_id, workspace_id, connected_account_id, state, scheduled_at, publish_due_at)
      values (${post.id}, ${ctx.workspaceId}, ${accountId}, ${state}, now() + interval '2 days', now() + interval '2 days') returning id`))[0];
    return { postId: post.id, targetId: t.id };
  });
}
const stateOf = (ctx: Ctx, id: string) =>
  withTenant(ctx, (tx) => tx.execute(sql`select state, scheduled_at from post_targets where id = ${id}`)).then((r) => asRows<{ state: string; scheduled_at: string | null }>(r)[0]);

describe('reschedule refusal is atomic and carries the reason', () => {
  it('a drop onto a past time is rejected with the reason, and the move does not stick', async () => {
    const { ctx, accountId } = await seed();
    const { targetId } = await scheduledTarget(ctx, accountId);
    const before = await stateOf(ctx, targetId);

    await expect(board.rescheduleTarget(ctx, targetId, { localDate: dayOffset(-2), localTime: '09:00', zone: 'UTC' }))
      .rejects.toThrow(/already passed/); // the exact user-facing reason

    const after = await stateOf(ctx, targetId);
    expect(after.scheduled_at).toBe(before.scheduled_at); // rolled back — no silent move
  });

  it('a valid future move commits', async () => {
    const { ctx, accountId } = await seed();
    const { targetId } = await scheduledTarget(ctx, accountId);
    const r = await board.rescheduleTarget(ctx, targetId, { localDate: dayOffset(5), localTime: '09:00', zone: 'UTC' });
    expect(r.instant).toBe(`${dayOffset(5)}T09:00:00.000Z`);
    // scheduled_at reads back as a Postgres timestamp string; compare as instants.
    expect(new Date((await stateOf(ctx, targetId)).scheduled_at as string).toISOString()).toBe(r.instant);
  });
});

describe('a failed target retries independently of its siblings', () => {
  it('retrying one target does not touch the others', async () => {
    const { ctx, accountId } = await seed();
    // A post fanned to two accounts: one FAILED, one already PUBLISHED.
    const acct2 = await withTenant(ctx, (tx) => tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status) values (${ctx.workspaceId}, 'bluesky', ${'pa-' + uniq()}, 'UTC', 'active') returning id`)).then((r) => asRows<{ id: string }>(r)[0].id);
    const { postId, targetId: failed } = await withTenant(ctx, async (tx) => {
      const post = asRows<{ id: string }>(await tx.execute(sql`insert into posts (workspace_id, author_id, status) values (${ctx.workspaceId}, ${ctx.userId}, 'partially_published') returning id`))[0];
      const f = asRows<{ id: string }>(await tx.execute(sql`insert into post_targets (post_id, workspace_id, connected_account_id, state, failure_code, last_error) values (${post.id}, ${ctx.workspaceId}, ${accountId}, 'failed', 'content_rejected', ${JSON.stringify({ plainLanguage: 'rejected' })}::jsonb) returning id`))[0];
      return { postId: post.id, targetId: f.id };
    });
    const sibling = asRows<{ id: string }>(await withTenant(ctx, (tx) => tx.execute(sql`insert into post_targets (post_id, workspace_id, connected_account_id, state, published_at, provider_post_id) values (${postId}, ${ctx.workspaceId}, ${acct2}, 'published', now(), 'pp-1') returning id`)))[0].id;

    await board.retryTarget(ctx, failed);

    expect((await stateOf(ctx, failed)).state).toBe('scheduled');   // retried
    expect((await stateOf(ctx, sibling)).state).toBe('published');  // sibling untouched
  });
});
