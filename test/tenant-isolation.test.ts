// test/tenant-isolation.test.ts
// Proves RLS makes cross-workspace rows INVISIBLE (0 rows => 404, never 403). Two guards keep this
// suite from ever passing for the wrong reason:
//   1. It asserts the app connection is meridian_app and is NOT superuser / NOT bypassrls. Point
//      DATABASE_URL at a superuser and this suite FAILS rather than passing vacuously.
//   2. A CANARY connects as a BYPASSRLS/superuser role, sets the SAME workspace GUC, and asserts
//      the cross-tenant query DOES return the row. If the canary ever returns 0, either the seed
//      failed or RLS is not what's hiding the row — the whole suite is lying, so the canary fails.
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant } from '../src/db/tenant';
import * as workspaces from '../src/workspaces/service';
import { authorize, ForbiddenError } from '../src/authz/abilities';
import { adminDb, asRows } from './helpers/db';

async function createUser(email: string): Promise<string> {
  return asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${email}) returning id`))[0].id;
}

describe('cross-workspace isolation (RLS)', () => {
  let userA: string;
  let userB: string;
  let wsA: string;
  let wsB: string;
  const bIds: Record<string, string> = {};
  const stamp = String(Date.now());

  beforeAll(async () => {
    // GUARD 1: the app must connect as a non-privileged role, or RLS is silently off.
    const who = asRows<{ current_user: string; super: boolean; bypass: boolean }>(await db.execute(sql`
      select current_user,
             (select rolsuper     from pg_roles where rolname = current_user) as super,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypass
    `))[0];
    expect(who.current_user).toBe('meridian_app');
    expect(who.super).toBe(false);
    expect(who.bypass).toBe(false);

    userA = await createUser(`a-${stamp}@meridian.test`);
    userB = await createUser(`b-${stamp}@meridian.test`);
    ({ workspaceId: wsA } = await workspaces.createWorkspace(userA, 'Alpha'));
    ({ workspaceId: wsB } = await workspaces.createWorkspace(userB, 'Bravo'));

    await withTenant({ workspaceId: wsB, userId: userB, role: 'owner' }, async (tx) => {
      bIds.account = asRows<{ id: string }>(await tx.execute(sql`
        insert into connected_accounts (workspace_id, provider, provider_account_id, timezone)
        values (${wsB}, 'bluesky', ${'acct-' + stamp}, 'Asia/Ho_Chi_Minh') returning id`))[0].id;
      bIds.post = asRows<{ id: string }>(await tx.execute(sql`
        insert into posts (workspace_id, author_id) values (${wsB}, ${userB}) returning id`))[0].id;
      bIds.media = asRows<{ id: string }>(await tx.execute(sql`
        insert into media_assets (workspace_id, kind, storage_key, mime_type)
        values (${wsB}, 'image', ${'k-' + stamp}, 'image/png') returning id`))[0].id;
      bIds.apiKey = asRows<{ id: string }>(await tx.execute(sql`
        insert into api_keys (workspace_id, name, key_prefix, key_hash)
        values (${wsB}, 'k', 'mrdn_live_x', ${'hash-' + stamp}) returning id`))[0].id;
    });
  });

  it('a member of A cannot read B\'s post, account, media, or API key (all 0 rows => 404)', async () => {
    await withTenant({ workspaceId: wsA, userId: userA, role: 'owner' }, async (tx) => {
      expect(asRows(await tx.execute(sql`select id from posts where id = ${bIds.post}`))).toHaveLength(0);
      expect(asRows(await tx.execute(sql`select id from connected_accounts where id = ${bIds.account}`))).toHaveLength(0);
      expect(asRows(await tx.execute(sql`select id from media_assets where id = ${bIds.media}`))).toHaveLength(0);
      expect(asRows(await tx.execute(sql`select id from api_keys where id = ${bIds.apiKey}`))).toHaveLength(0);
    });
  });

  it('CANARY: a BYPASSRLS connection with the SAME GUC DOES see the row (RLS is the thing hiding it)', async () => {
    // Prove the admin connection actually bypasses RLS, else the canary would be meaningless.
    const priv = asRows<{ privileged: boolean }>(await adminDb.execute(sql`
      select (rolsuper or rolbypassrls) as privileged from pg_roles where rolname = current_user`))[0];
    expect(priv.privileged).toBe(true);

    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', ${wsA}, true)`); // same context as the app test
      const post = asRows(await tx.execute(sql`select id from posts where id = ${bIds.post}`));
      expect(post).toHaveLength(1); // visible ONLY because RLS is bypassed here
    });
  });

  it('the same rows ARE visible within their own workspace (control)', async () => {
    await withTenant({ workspaceId: wsB, userId: userB, role: 'owner' }, async (tx) => {
      expect(asRows(await tx.execute(sql`select id from posts where id = ${bIds.post}`))).toHaveLength(1);
    });
  });

  it('the four denormalized workspace_id columns are NOT NULL', async () => {
    const cols = asRows<{ table_name: string; is_nullable: string }>(await db.execute(sql`
      select table_name, is_nullable from information_schema.columns
      where column_name = 'workspace_id'
        and table_name in ('oauth_tokens','media_variants','post_target_overrides','publish_attempts')
    `));
    expect(cols).toHaveLength(4);
    for (const c of cols) expect(c.is_nullable).toBe('NO');
  });

  it('a child row omitting workspace_id derives it from its parent and lands in the right tenant', async () => {
    await withTenant({ workspaceId: wsB, userId: userB, role: 'owner' }, async (tx) => {
      const variant = asRows<{ id: string; workspace_id: string }>(await tx.execute(sql`
        insert into media_variants (media_asset_id, purpose, storage_key, mime_type)
        values (${bIds.media}, 'thumbnail', 'vk', 'image/png') returning id, workspace_id`))[0];
      expect(variant.workspace_id).toBe(wsB); // trigger filled it from media_assets
    });
    // ...and it is invisible from workspace A.
    await withTenant({ workspaceId: wsA, userId: userA, role: 'owner' }, async (tx) => {
      expect(asRows(await tx.execute(sql`select id from media_variants where media_asset_id = ${bIds.media}`))).toHaveLength(0);
    });
  });

  it('the last Owner cannot demote themselves or leave', async () => {
    await expect(workspaces.changeRole({ userId: userA, role: 'owner', workspaceId: wsA }, userA, 'approver')).rejects.toThrow('last_owner');
    await expect(workspaces.leaveWorkspace({ userId: userA, role: 'owner', workspaceId: wsA })).rejects.toThrow('last_owner');
  });

  it('an Analyst is refused a write, and an Editor cannot approve their own post', () => {
    expect(() => authorize({ userId: userA, role: 'analyst' }, 'post:create')).toThrow(ForbiddenError);
    expect(() => authorize({ userId: userA, role: 'editor' }, 'approval:approve', { authorId: userA })).toThrow(ForbiddenError);
  });
});
