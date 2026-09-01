// src/accounts/connect.ts
// The connect flow for both auth kinds. OAuth-redirect uses a single-use, expiring, user+workspace
// bound state (with PKCE); credential providers submit their fields directly.
//
// Same social account in two workspaces: ALLOWED and independent. The unique key is
// (workspace_id, provider, provider_account_id), so an agency and its client can each connect the
// same Instagram account; each holds its own tokens and revoking one does not touch the other.
// WITHIN a workspace, reconnecting REATTACHES to the existing account row (upsert), so scheduled
// posts that reference it survive rather than being orphaned.
import { sql } from 'drizzle-orm';
import { randomBytes, createHash } from 'node:crypto';
import { withTenant, withUser, type Tx } from '../db/tenant';
import { resolveAdapter } from '../providers/registry';
import { authorize } from '../authz/abilities';
import type { ScopedActor } from '../workspaces/service';
import { storeTokens } from '../vault/tokens';
import { writeAudit } from '../audit/audit';
import type { AuthResult } from '../providers/types';

export class ConnectError extends Error {
  constructor(code: string) { super(code); this.name = 'ConnectError'; }
}

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
const hashState = (raw: string): string => createHash('sha256').update(raw).digest('hex');

// --- start ---
export type BeginResult =
  | { kind: 'oauth_redirect'; url: string }
  | { kind: 'credentials'; provider: string; fields: { key: string; label: string; secret: boolean }[] };

export async function beginConnect(actor: ScopedActor, provider: string, redirectUri: string): Promise<BeginResult> {
  const adapter = resolveAdapter(provider);
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'account:connect');
    const start = await adapter.beginAuthorization({ workspaceId: actor.workspaceId, redirectUri });
    if (start.kind === 'credentials') {
      return { kind: 'credentials', provider, fields: start.fields };
    }
    // Bind the adapter's state to this user+workspace, single-use, 10-minute expiry.
    await tx.execute(sql`
      insert into oauth_states (state_hash, workspace_id, user_id, provider, code_verifier, redirect_uri, expires_at)
      values (${hashState(start.state)}, ${actor.workspaceId}, ${actor.userId}, ${provider},
              ${start.codeVerifier ?? null}, ${redirectUri}, now() + interval '10 minutes')
    `);
    return { kind: 'oauth_redirect', url: start.url };
  });
}

// --- credential-kind completion (no redirect) ---
export async function completeCredentialConnect(actor: ScopedActor, provider: string, fields: Record<string, string>) {
  const adapter = resolveAdapter(provider);
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'account:connect');
    const result = await adapter.exchangeCallback({ fields });
    return persistConnectedAccount(tx, { workspaceId: actor.workspaceId, userId: actor.userId, provider, result });
  });
}

// --- oauth callback ---
export type CallbackResult =
  | { status: 'connected' | 'reconnected'; accountId: string }
  | { status: 'denied' };

export async function handleOAuthCallback(
  userId: string,
  params: { state?: string; code?: string; error?: string },
): Promise<CallbackResult> {
  return withUser(userId, async (tx) => {
    // User denied consent at the provider.
    if (params.error && !params.code) {
      if (params.state) {
        await tx.execute(sql`update oauth_states set consumed_at = now() where state_hash = ${hashState(params.state)} and user_id = ${userId} and consumed_at is null`);
      }
      return { status: 'denied' };
    }
    if (!params.state || !params.code) throw new ConnectError('invalid_callback');

    // Atomically consume the state: a second (replayed) callback finds no unconsumed row.
    const st = rows<{ workspace_id: string; provider: string; code_verifier: string | null; redirect_uri: string }>(
      await tx.execute(sql`
        update oauth_states set consumed_at = now()
        where state_hash = ${hashState(params.state)} and user_id = ${userId}
          and consumed_at is null and expires_at > now()
        returning workspace_id, provider, code_verifier, redirect_uri
      `),
    );
    if (!st.length) throw new ConnectError('state_invalid_or_replayed');

    const s = st[0];
    const adapter = resolveAdapter(s.provider);
    const result = await adapter.exchangeCallback({
      code: params.code, state: params.state, codeVerifier: s.code_verifier ?? undefined, redirectUri: s.redirect_uri,
    });
    return persistConnectedAccount(tx, { workspaceId: s.workspace_id, userId, provider: s.provider, result });
  });
}

// --- persistence (upsert on the tenant unique key; reattach on conflict) ---
async function persistConnectedAccount(
  tx: Tx,
  params: { workspaceId: string; userId: string; provider: string; result: AuthResult },
): Promise<CallbackResult> {
  // Establish tenant context (the callback path enters via withUser with no workspace set).
  await tx.execute(sql`select set_config('app.workspace_id', ${params.workspaceId}, true)`);
  const a = params.result.account;
  const acc = rows<{ id: string; inserted: boolean }>(await tx.execute(sql`
    insert into connected_accounts (
      workspace_id, provider, provider_account_id, handle, display_name, avatar_url, timezone, status, connected_by
    ) values (
      ${params.workspaceId}, ${params.provider}, ${a.providerAccountId}, ${a.handle ?? null}, ${a.displayName ?? null},
      ${a.avatarUrl ?? null}, coalesce((select default_timezone from workspaces where id = ${params.workspaceId}), 'UTC'),
      'active', ${params.userId}
    )
    on conflict (workspace_id, provider, provider_account_id) do update set
      handle = excluded.handle, display_name = excluded.display_name, avatar_url = excluded.avatar_url,
      status = 'active', health_notified_status = null, health_notified_at = null, updated_at = now()
    returning id, (xmax = 0) as inserted
  `));
  const accountId = acc[0].id;
  const reattached = !acc[0].inserted;

  await storeTokens(tx, { connectedAccountId: accountId, workspaceId: params.workspaceId, credentials: params.result.credentials });

  // Audit records the connection event WITHOUT any token material.
  await writeAudit(tx, {
    workspaceId: params.workspaceId, actorUserId: params.userId,
    action: reattached ? 'account.reconnected' : 'account.connected',
    targetType: 'connected_account', targetId: accountId,
    after: { provider: params.provider, providerAccountId: a.providerAccountId, handle: a.handle ?? null },
  });

  return { status: reattached ? 'reconnected' : 'connected', accountId };
}
