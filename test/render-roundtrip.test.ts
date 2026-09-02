// test/render-roundtrip.test.ts
// The payload a target renders to (what the composer previews) is byte-identical — via canonical
// JSON — to what gets persisted as rendered_payload and later handed to the publisher. Integration.
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant } from '../src/db/tenant';
import { createWorkspace } from '../src/workspaces/service';
import { mergeContent, renderTarget, canonicalJSON, type PostContent, type MediaAssetInfo } from '../src/posts/content';
import { asRows } from './helpers/db';

async function createUser(email: string): Promise<string> {
  return asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${email}) returning id`))[0].id;
}

describe('render round-trip', () => {
  it('rendered_payload persisted to jsonb reloads byte-identical (canonical) to the preview', async () => {
    const stamp = String(Date.now());
    const userId = await createUser(`render-${stamp}@meridian.test`);
    const { workspaceId } = await createWorkspace(userId, 'Render');

    const parent: PostContent = { text: 'Launch 🚀 today Việt', link: 'https://x.co', firstComment: 'first!', media: ['m1'] };
    const media = new Map<string, MediaAssetInfo>([
      ['m1', { id: 'm1', kind: 'image', url: 'https://cdn.test/x.png', status: 'ready', width: 1080, height: 1080, mimeType: 'image/png' }],
    ]);

    // The ONE render path — used for both the preview and persistence.
    const { post: preview } = renderTarget(mergeContent(parent, {}), media);
    const previewCanonical = canonicalJSON(preview);

    // Rendering again with the same inputs is deterministic.
    const { post: preview2 } = renderTarget(mergeContent(parent, {}), media);
    expect(canonicalJSON(preview2)).toBe(previewCanonical);

    const reloaded = await withTenant({ workspaceId, userId, role: 'owner' }, async (tx) => {
      const acc = asRows<{ id: string }>(await tx.execute(sql`
        insert into connected_accounts (workspace_id, provider, provider_account_id, timezone)
        values (${workspaceId}, 'bluesky', ${'acct-' + stamp}, 'UTC') returning id`))[0];
      const post = asRows<{ id: string }>(await tx.execute(sql`
        insert into posts (workspace_id, author_id, content) values (${workspaceId}, ${userId}, ${JSON.stringify(parent)}::jsonb) returning id`))[0];
      const target = asRows<{ id: string }>(await tx.execute(sql`
        insert into post_targets (post_id, workspace_id, connected_account_id, state)
        values (${post.id}, ${workspaceId}, ${acc.id}, 'draft') returning id`))[0];

      // Persist exactly what the publisher will later read.
      await tx.execute(sql`update post_targets set rendered_payload = ${JSON.stringify(preview)}::jsonb where id = ${target.id}`);
      return asRows<{ rendered_payload: unknown }>(await tx.execute(sql`select rendered_payload from post_targets where id = ${target.id}`))[0].rendered_payload;
    });

    // jsonb may reorder keys; canonical form proves semantic byte-identity of the payload.
    expect(canonicalJSON(reloaded)).toBe(previewCanonical);
  });
});
