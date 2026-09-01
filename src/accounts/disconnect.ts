// src/accounts/disconnect.ts
// Disconnect = revoke at the provider (best-effort), soft-delete locally (keep the row so published
// history + analytics survive), drop the stored tokens, and resolve queued posts.
//
// Queued-post rule: an EXPLICIT disconnect is a deliberate "stop using this account", so
// not-yet-published targets for it are moved to 'skipped' NOW, loudly (never silently dropped).
// This is different from an INVOLUNTARY auth_expired (handled in health/refresh), where targets stay
// scheduled and resume if the user reconnects in time — reconnect reattaches to the same account row.
import { sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/tenant';
import { resolveAdapter } from '../providers/registry';
import { authorize } from '../authz/abilities';
import type { ScopedActor } from '../workspaces/service';
import { loadTokens } from '../vault/tokens';
import { writeAudit } from '../audit/audit';
import { emitEvent } from '../events/emit';

export class DisconnectError extends Error {
  constructor(code: string) { super(code); this.name = 'DisconnectError'; }
}

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

export async function disconnectAccount(actor: ScopedActor, accountId: string): Promise<{ skippedTargets: number }> {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx: Tx) => {
    authorize(actor, 'account:disconnect');

    const found = rows<{ provider: string; provider_account_id: string }>(await tx.execute(sql`
      select provider, provider_account_id from connected_accounts where id = ${accountId} and status <> 'disconnected'
    `));
    if (!found.length) throw new DisconnectError('not_found'); // RLS => cross-tenant is also not_found
    const provider = found[0].provider;

    // Best-effort revoke at the provider.
    const adapter = resolveAdapter(provider);
    if (adapter.capabilities.supportsRevoke && adapter.revokeAuthorization) {
      const loaded = await loadTokens(tx, accountId);
      if (loaded) {
        await adapter.revokeAuthorization({
          account: { providerAccountId: found[0].provider_account_id, credentials: loaded.credentials },
        }).catch(() => { /* provider may already have revoked; ignore */ });
      }
    }

    // Soft-delete locally; drop the credentials so we stop holding them.
    await tx.execute(sql`update connected_accounts set status = 'disconnected', updated_at = now() where id = ${accountId}`);
    await tx.execute(sql`delete from oauth_tokens where connected_account_id = ${accountId}`);

    // Skip queued (not-yet-published) targets, loudly.
    const skipped = rows<{ id: string }>(await tx.execute(sql`
      update post_targets set state = 'skipped', lease_expires_at = null, updated_at = now(),
        last_error = ${JSON.stringify({ code: 'account_disconnected', plainLanguage: 'The connected account was disconnected before this could publish.' })}::jsonb
      where connected_account_id = ${accountId} and state = 'scheduled'
      returning id
    `));
    for (const t of skipped) {
      await emitEvent(tx, { workspaceId: actor.workspaceId, aggregateType: 'post_target', aggregateId: t.id, type: 'post_target.skipped', payload: { reason: 'account_disconnected' } });
    }

    await writeAudit(tx, {
      workspaceId: actor.workspaceId, actorUserId: actor.userId, action: 'account.disconnected',
      targetType: 'connected_account', targetId: accountId, after: { skippedTargets: skipped.length },
    });
    return { skippedTargets: skipped.length };
  });
}
