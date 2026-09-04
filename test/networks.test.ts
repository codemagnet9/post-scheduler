// test/networks.test.ts
// The Phase 6 read models: account health, the provider catalog (+ honest coming-soon list), and the
// comment author-name join. The fake adapter is registered under NODE_ENV=test (adapters/index), so it
// appears in the catalog here and never in a production boot.
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant } from '../src/db/tenant';
import { createWorkspace } from '../src/workspaces/service';
import { accountHealth, providerCatalog, COMING_SOON } from '../src/accounts/catalog';
import { createDraft } from '../src/posts/service';
import { addComment, listComments } from '../src/comments/service';
import '../src/providers/adapters/index'; // registers bluesky/line + fake (test env)
import { asRows } from './helpers/db';

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
async function createUser(name: string): Promise<string> {
  return asRows<{ id: string }>(await db.execute(sql`insert into users (email, name) values (${`n-${uniq()}@meridian.test`}, ${name}) returning id`))[0].id;
}

describe('account health read model', () => {
  it('returns each connected account with its status, capability notes, and no publishes yet', async () => {
    const owner = await createUser('Net Owner');
    const { workspaceId } = await createWorkspace(owner, 'Networks');
    const actor = { userId: owner, role: 'owner' as const, workspaceId };

    await withTenant(actor, (tx) => tx.execute(sql`
      insert into connected_accounts (workspace_id, provider, provider_account_id, handle, timezone, status)
      values (${workspaceId}, 'fake', ${'acc-' + uniq()}, 'fakehandle', 'UTC', 'active')
    `));

    const health = await accountHealth(actor);
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ provider: 'fake', handle: 'fakehandle', status: 'active', lastPublishedAt: null, queuedCount: 0 });
    // Capability notes come live from the descriptor, not hard-coded copy.
    expect(health[0].capabilities?.charLimit).toBe(1000);
    expect(health[0].capabilities?.firstComment).toBe(true);
    expect(health[0].capabilities?.surface).toMatch(/public feed/i);
  });

  it('a disconnected account is not listed', async () => {
    const owner = await createUser('Net Owner 2');
    const { workspaceId } = await createWorkspace(owner, 'Networks2');
    const actor = { userId: owner, role: 'owner' as const, workspaceId };
    await withTenant(actor, (tx) => tx.execute(sql`
      insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status)
      values (${workspaceId}, 'fake', ${'acc-' + uniq()}, 'UTC', 'disconnected')
    `));
    expect(await accountHealth(actor)).toHaveLength(0);
  });
});

describe('provider catalog', () => {
  it('lists registered adapters as connectable and names the partner-gated networks honestly', () => {
    const cat = providerCatalog();
    expect(cat.available.map((c) => c.provider)).toContain('fake'); // registered in test
    // The coming-soon list is the honest set, each with a blocking reason.
    expect(cat.comingSoon).toBe(COMING_SOON);
    expect(cat.comingSoon.map((c) => c.name).join(' ')).toMatch(/LinkedIn/);
    for (const c of cat.comingSoon) expect(c.blockedOn.length).toBeGreaterThan(0);
  });
});

describe('comment author names', () => {
  it('lists a comment with the author’s name joined in', async () => {
    const owner = await createUser('Ada Commenter');
    const { workspaceId } = await createWorkspace(owner, 'Comments');
    const actor = { userId: owner, role: 'owner' as const, workspaceId };
    const { postId } = await createDraft(actor, { content: { text: 'hi', media: [] }, targetAccountIds: [] });
    await addComment(actor, postId, 'looks good');
    const comments = asRows<{ author_name: string | null; body: string }>(await listComments(actor, postId));
    expect(comments).toHaveLength(1);
    expect(comments[0].author_name).toBe('Ada Commenter');
    expect(comments[0].body).toBe('looks good');
  });
});
