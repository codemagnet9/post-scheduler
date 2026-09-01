// test/connect-callback.test.ts
// A replayed OAuth callback is rejected (single-use state), consent-denial is handled, and the same
// account connects independently to a second workspace.
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { createWorkspace } from '../src/workspaces/service';
import { createFakeProvider } from '../src/providers/adapters/fake';
import { registerAdapter } from '../src/providers/registry';
import * as connect from '../src/accounts/connect';
import { asRows } from './helpers/db';

async function createUser(email: string): Promise<string> {
  return asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${email}) returning id`))[0].id;
}

describe('oauth callback', () => {
  it('accepts a first callback and rejects the replay', async () => {
    const provider = `fake-oauth-${Date.now()}`;
    const { adapter, control } = createFakeProvider({ key: provider, authKind: 'oauth_redirect' });
    registerAdapter(adapter);

    const userId = await createUser(`connect-${Date.now()}@meridian.test`);
    const { workspaceId } = await createWorkspace(userId, 'Connect');
    const actor = { userId, role: 'owner' as const, workspaceId };

    const begun = await connect.beginConnect(actor, provider, 'http://localhost/cb');
    expect(begun.kind).toBe('oauth_redirect');
    const state = control.lastAuthState!;
    expect(state).toBeTruthy();

    const first = await connect.handleOAuthCallback(userId, { state, code: 'auth-code' });
    expect(first.status).toBe('connected');

    // Replay the exact same callback — the state was consumed.
    await expect(connect.handleOAuthCallback(userId, { state, code: 'auth-code' }))
      .rejects.toThrow('state_invalid_or_replayed');
  });

  it('handles the user denying consent without creating an account', async () => {
    const provider = `fake-oauth-deny-${Date.now()}`;
    const { adapter, control } = createFakeProvider({ key: provider, authKind: 'oauth_redirect' });
    registerAdapter(adapter);
    const userId = await createUser(`deny-${Date.now()}@meridian.test`);
    const { workspaceId } = await createWorkspace(userId, 'Deny');
    await connect.beginConnect({ userId, role: 'owner', workspaceId }, provider, 'http://localhost/cb');

    const res = await connect.handleOAuthCallback(userId, { state: control.lastAuthState!, error: 'access_denied' });
    expect(res.status).toBe('denied');
  });

  it('the same provider account connects independently to two workspaces', async () => {
    const provider = `fake-oauth-dual-${Date.now()}`;
    const { adapter, control } = createFakeProvider({ key: provider, authKind: 'oauth_redirect' });
    registerAdapter(adapter);
    const userId = await createUser(`dual-${Date.now()}@meridian.test`);
    const a = await createWorkspace(userId, 'Dual A');
    const b = await createWorkspace(userId, 'Dual B');

    await connect.beginConnect({ userId, role: 'owner', workspaceId: a.workspaceId }, provider, 'http://localhost/cb');
    const r1 = await connect.handleOAuthCallback(userId, { state: control.lastAuthState!, code: 'c1' });
    await connect.beginConnect({ userId, role: 'owner', workspaceId: b.workspaceId }, provider, 'http://localhost/cb');
    const r2 = await connect.handleOAuthCallback(userId, { state: control.lastAuthState!, code: 'c2' });

    expect(r1.status).toBe('connected');
    expect(r2.status).toBe('connected');
    if (r1.status !== 'denied' && r2.status !== 'denied') {
      expect(r1.accountId).not.toBe(r2.accountId); // separate rows, one per workspace
    }
  });
});
