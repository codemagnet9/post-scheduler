// src/accounts/catalog.ts
// Read models for the Networks screen: the health of each connected account, and the catalog of
// networks you can connect. Capability notes are read LIVE from each adapter's descriptor (never
// re-described here), so the screen can never claim a capability the adapter doesn't have. The
// "coming soon" list is honest about what's blocking each gated network — a feature, not an apology.
import { sql } from 'drizzle-orm';
import { withTenant } from '../db/tenant';
import { authorize } from '../authz/abilities';
import { listProviders, resolveAdapter } from '../providers/registry';
import type { ScopedActor } from '../workspaces/service';
import type { PublicationSurface } from '../providers/types';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

const SURFACE_NOTE: Record<PublicationSurface, string> = {
  public_feed: 'Publishes to a public feed',
  follower_broadcast: 'Broadcasts to your followers — not a public feed',
  channel: 'Posts to your channel — not a public feed',
  private: 'Private — not publicly visible',
};

// The capability facts a person cares about on the Networks screen, derived from the descriptor.
export interface CapabilityNote { surface: string; charLimit: number; firstComment: boolean; threads: string }
function capabilityNote(provider: string): CapabilityNote {
  const c = resolveAdapter(provider).capabilities;
  const threads = c.threadSupport === 'thread' ? 'Threads supported'
    : c.threadSupport === 'carousel' ? 'Carousels supported'
    : 'Single posts only';
  return { surface: SURFACE_NOTE[c.publicationSurface], charLimit: c.maxTextLength, firstComment: c.supportsFirstComment, threads };
}

export interface AccountHealth {
  id: string;
  provider: string;
  displayName: string | null;
  handle: string | null;
  status: string;         // active | auth_expired | needs_review | revoked | suspended
  timezone: string;
  lastPublishedAt: string | null;
  queuedCount: number;    // scheduled targets that still depend on this account
  capabilities: CapabilityNote | null; // null if the adapter isn't registered (shouldn't happen)
}

export async function accountHealth(actor: ScopedActor): Promise<AccountHealth[]> {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'account:view');
    const accts = rows<{ id: string; provider: string; handle: string | null; display_name: string | null; status: string; timezone: string; last_published_at: string | null; queued_count: number }>(await tx.execute(sql`
      select ca.id, ca.provider, ca.handle, ca.display_name, ca.status, ca.timezone,
             (select max(pt.published_at) from post_targets pt where pt.connected_account_id = ca.id and pt.state = 'published') as last_published_at,
             (select count(*) from post_targets pt where pt.connected_account_id = ca.id and pt.state = 'scheduled')::int as queued_count
      from connected_accounts ca
      where ca.status <> 'disconnected'
      order by ca.display_name nulls last, ca.handle
    `));
    return accts.map((a) => ({
      id: a.id, provider: a.provider, displayName: a.display_name, handle: a.handle,
      status: a.status, timezone: a.timezone,
      lastPublishedAt: a.last_published_at ? new Date(a.last_published_at).toISOString() : null,
      queuedCount: Number(a.queued_count ?? 0),
      capabilities: hasProvider(a.provider) ? capabilityNote(a.provider) : null,
    }));
  });
}

function hasProvider(provider: string): boolean {
  return listProviders().includes(provider);
}

// The connect picker: every registered network, with its capability notes. authKind is discovered when
// the user actually starts the connect (beginConnect returns oauth_redirect vs credentials), so it's not
// pre-computed here.
export interface CatalogEntry { provider: string; displayName: string; capabilities: CapabilityNote }
export interface ComingSoonEntry { name: string; blockedOn: string }

// Networks gated on partner approval. Stated plainly so a customer never wonders why they're missing.
export const COMING_SOON: ComingSoonEntry[] = [
  { name: 'LinkedIn (Community Management API)', blockedOn: 'Pending LinkedIn partner approval for the Community Management API — required to post as an organization.' },
  { name: 'TikTok (Content Posting API)', blockedOn: 'Awaiting TikTok Content Posting API access review; direct publish is invite-only.' },
  { name: 'Instagram (Business / Graph API)', blockedOn: 'Requires a Meta App Review for instagram_content_publish plus a linked Facebook Page.' },
];

export function providerCatalog(): { available: CatalogEntry[]; comingSoon: ComingSoonEntry[] } {
  // Every REGISTERED adapter is connectable. The fake provider is only ever registered under
  // NODE_ENV=test or the explicit E2E flag (see adapters/index.ts), so it can appear here in those
  // runs — and never in a production boot, where it isn't registered at all.
  const available = listProviders()
    .map((provider) => ({ provider, displayName: resolveAdapter(provider).capabilities.displayName, capabilities: capabilityNote(provider) }));
  return { available, comingSoon: COMING_SOON };
}
