// test/notifications.test.ts
// Preferences respected per channel, and dedupe discipline: many signals about one account collapse
// to one reconnection alert.
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant } from '../src/db/tenant';
import { createWorkspace } from '../src/workspaces/service';
import { createDraft } from '../src/posts/service';
import { emitEvent } from '../src/events/emit';
import { setPreference } from '../src/notifications/preferences';
import { dispatchNotificationsTick } from '../src/notifications/dispatcher';
import { FakeEmailProvider, setEmailProvider } from '../src/notifications/email';
import type { Role } from '../src/authz/abilities';
import { adminDb, asRows } from './helpers/db';

// The dispatcher processes 200 events per tick; in the full suite many events precede ours, so drain.
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if ((await dispatchNotificationsTick(adminDb)) === 0) return;
  }
}

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
const createUser = async (label: string) => {
  const email = `${label}-${uniq()}@meridian.test`;
  const id = asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${email}) returning id`))[0].id;
  return { id, email };
};

describe('notification preferences', () => {
  it('a channel turned off is not delivered; other channels still are', async () => {
    const owner = await createUser('owner');
    const editor = await createUser('editor');
    const approver = await createUser('approver');
    const { workspaceId } = await createWorkspace(owner.id, 'Notify');
    const A = (userId: string, role: Role) => ({ userId, role, workspaceId });

    const accId = await withTenant(A(owner.id, 'owner'), async (tx) => {
      await tx.execute(sql`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${editor.id}, 'editor')`);
      await tx.execute(sql`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${approver.id}, 'approver')`);
      return asRows<{ id: string }>(await tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone) values (${workspaceId}, 'x', ${'pa-' + uniq()}, 'UTC') returning id`))[0].id;
    });
    const { postId } = await createDraft(A(editor.id, 'editor'), { content: { text: 'x', media: [] }, targetAccountIds: [accId] });

    // The approver turns OFF email for approval requests.
    await setPreference(A(approver.id, 'approver'), 'needs_approval', 'email', false);

    await withTenant(A(owner.id, 'owner'), (tx) => emitEvent(tx, { workspaceId, aggregateType: 'post', aggregateId: postId, type: 'post.submitted', payload: {} }));

    const fake = new FakeEmailProvider();
    setEmailProvider(fake);
    await drain();

    const notif = asRows<{ channels: string[] }>(await withTenant(A(approver.id, 'approver'), (tx) => tx.execute(sql`select channels from notifications where user_id = ${approver.id} and event_type = 'needs_approval'`)));
    expect(notif).toHaveLength(1);
    expect(notif[0].channels).toContain('in_app');
    expect(notif[0].channels).not.toContain('email'); // turned off
    expect(fake.sent.find((m) => m.to === approver.email)).toBeUndefined(); // and no email went out
  });
});

describe('delivery dedupe', () => {
  it('ten reconnection signals against one account produce ONE alert', async () => {
    const owner = await createUser('owner');
    const { workspaceId } = await createWorkspace(owner.id, 'Dedupe');
    const A = (userId: string, role: Role) => ({ userId, role, workspaceId });
    const accId = await withTenant(A(owner.id, 'owner'), (tx) => tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone) values (${workspaceId}, 'x', ${'pa-' + uniq()}, 'UTC') returning id`)).then((r) => asRows<{ id: string }>(r)[0].id);

    // Ten separate auth_expired signals for the SAME account.
    for (let i = 0; i < 10; i += 1) {
      await withTenant(A(owner.id, 'owner'), (tx) => emitEvent(tx, { workspaceId, aggregateType: 'connected_account', aggregateId: accId, type: 'connected_account.auth_expired', payload: { i } }));
    }

    setEmailProvider(new FakeEmailProvider());
    await drain();

    const alerts = asRows(await withTenant(A(owner.id, 'owner'), (tx) => tx.execute(sql`select id from notifications where user_id = ${owner.id} and event_type = 'account_reconnect' and dedupe_key = ${`reconnect:${workspaceId}:${accId}:${owner.id}`}`)));
    expect(alerts).toHaveLength(1); // deduped to one
  });
});
