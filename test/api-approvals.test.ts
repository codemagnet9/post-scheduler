// test/api-approvals.test.ts
// The gate, tested from the API surface (not just the service): an Editor hitting POST /schedule is
// refused; the approval path (submit -> approve) works over HTTP.
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant } from '../src/db/tenant';
import { buildServer } from '../src/server';
import { hashPassword } from '../src/auth/password';
import { login } from '../src/auth/service';
import { createWorkspace } from '../src/workspaces/service';
import { createDraft, setSchedule } from '../src/posts/service';
import { createFakeProvider } from '../src/providers/adapters/fake';
import { registerAdapter } from '../src/providers/registry';
import type { Role } from '../src/authz/abilities';
import { asRows } from './helpers/db';

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;

async function userWithPassword(): Promise<{ id: string; email: string }> {
  const email = `api-${uniq()}@meridian.test`;
  const pw = await hashPassword('password123');
  const id = asRows<{ id: string }>(await db.execute(sql`insert into users (email, password_hash, email_verified_at) values (${email}, ${pw}, now()) returning id`))[0].id;
  return { id, email };
}
const token = async (email: string) => (await login({ email, password: 'password123' }, { ip: '127.0.0.1' })).accessToken;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('approval gate over the API', () => {
  it('Editor is 403 on POST /schedule; submit + approve flow works', async () => {
    const provider = `api-${uniq()}`;
    registerAdapter(createFakeProvider({ key: provider }).adapter);
    const owner = await userWithPassword();
    const editor = await userWithPassword();
    const approver = await userWithPassword();
    const { workspaceId } = await createWorkspace(owner.id, 'API');
    const A = (userId: string, role: Role) => ({ userId, role, workspaceId });

    const accId = await withTenant(A(owner.id, 'owner'), async (tx) => {
      await tx.execute(sql`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${editor.id}, 'editor')`);
      await tx.execute(sql`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${approver.id}, 'approver')`);
      return asRows<{ id: string }>(await tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status) values (${workspaceId}, ${provider}, ${'pa-' + uniq()}, 'UTC', 'active') returning id`))[0].id;
    });

    const { postId } = await createDraft(A(editor.id, 'editor'), { content: { text: 'via api', media: [] }, targetAccountIds: [accId] });
    await setSchedule(A(editor.id, 'editor'), postId, { type: 'fixed_instant', scheduledAt: new Date(Date.now() + 86400_000).toISOString() });

    const editorTok = await token(editor.email);
    const approverTok = await token(approver.email);

    const app = buildServer();
    await app.ready();
    try {
      const base = `/workspaces/${workspaceId}/posts/${postId}`;

      // The gate: an Editor cannot schedule directly.
      const denied = await app.inject({ method: 'POST', url: `${base}/schedule`, headers: auth(editorTok) });
      expect(denied.statusCode).toBe(403);

      // The Editor submits for review.
      const submitted = await app.inject({ method: 'POST', url: `${base}/submit`, headers: auth(editorTok) });
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json().status).toBe('pending_approval');

      // The Approver approves — which schedules it.
      const approved = await app.inject({ method: 'POST', url: `${base}/approve`, headers: auth(approverTok) });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().status).toBe('scheduled');

      // And the approver approving is enforced server-side even via the API: the editor can't approve.
      const editorApprove = await app.inject({ method: 'POST', url: `${base}/approve`, headers: auth(editorTok) });
      expect(editorApprove.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
