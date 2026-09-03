// test/approvals.test.ts
// The approval flow at the service layer, including every awkward case.
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant } from '../src/db/tenant';
import { createWorkspace } from '../src/workspaces/service';
import { createDraft, updatePost, setSchedule } from '../src/posts/service';
import { submitForApproval, approve, requestChanges, ApprovalError } from '../src/approvals/service';
import { createFakeProvider } from '../src/providers/adapters/fake';
import { registerAdapter } from '../src/providers/registry';
import { ForbiddenError, type Role } from '../src/authz/abilities';
import { asRows } from './helpers/db';

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
const createUser = async () => asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${`a-${uniq()}@meridian.test`}) returning id`))[0].id;

interface Scenario {
  workspaceId: string; postId: string;
  A: (userId: string, role: Role) => { userId: string; role: Role; workspaceId: string };
  owner: string; editor: string; approver: string; approver2: string; analyst: string;
}

async function scenario(opts: { paid?: boolean; schedule?: 'future' | 'past'; author?: 'editor' | 'approver' | 'owner' } = {}): Promise<Scenario> {
  const provider = `apr-${uniq()}`;
  registerAdapter(createFakeProvider({ key: provider }).adapter);
  const owner = await createUser();
  const editor = await createUser();
  const approver = await createUser();
  const approver2 = await createUser();
  const analyst = await createUser();
  const { workspaceId } = await createWorkspace(owner, 'Approvals');
  const A = (userId: string, role: Role) => ({ userId, role, workspaceId });

  const accId = await withTenant(A(owner, 'owner'), async (tx) => {
    for (const [uid, role] of [[editor, 'editor'], [approver, 'approver'], [approver2, 'approver'], [analyst, 'analyst']] as const) {
      await tx.execute(sql`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${uid}, ${role})`);
    }
    return asRows<{ id: string }>(await tx.execute(sql`insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status) values (${workspaceId}, ${provider}, ${'pa-' + uniq()}, 'UTC', 'active') returning id`))[0].id;
  });

  const authorRole = opts.author ?? 'editor';
  const authorId = authorRole === 'editor' ? editor : authorRole === 'approver' ? approver : owner;
  const author = A(authorId, authorRole);
  const { postId } = await createDraft(author, { content: { text: 'hello', media: [] }, targetAccountIds: [accId] });
  const when = opts.schedule === 'past' ? new Date(Date.now() - 3600_000) : new Date(Date.now() + 86400_000);
  await setSchedule(author, postId, { type: 'fixed_instant', scheduledAt: when.toISOString() });
  if (opts.paid) await withTenant(author, (tx) => tx.execute(sql`update posts set is_paid_promotion = true where id = ${postId}`));
  return { workspaceId, postId, A, owner, editor, approver, approver2, analyst };
}

const statusOf = (s: Scenario) =>
  withTenant(s.A(s.owner, 'owner'), (tx) => tx.execute(sql`select status from posts where id = ${s.postId}`)).then((r) => asRows<{ status: string }>(r)[0].status);

describe('approval flow', () => {
  it('submit moves a draft to pending_approval', async () => {
    const s = await scenario();
    await submitForApproval(s.A(s.editor, 'editor'), s.postId);
    expect(await statusOf(s)).toBe('pending_approval');
  });

  it('approve schedules the post', async () => {
    const s = await scenario();
    await submitForApproval(s.A(s.editor, 'editor'), s.postId);
    const r = await approve(s.A(s.approver, 'approver'), s.postId);
    expect(r.status).toBe('scheduled');
    expect(await statusOf(s)).toBe('scheduled');
  });

  it('request changes sends it back to changes_requested', async () => {
    const s = await scenario();
    await submitForApproval(s.A(s.editor, 'editor'), s.postId);
    await requestChanges(s.A(s.approver, 'approver'), s.postId, 'tighten the copy');
    expect(await statusOf(s)).toBe('changes_requested');
  });

  it('an Editor cannot schedule directly — post:schedule is denied (service guard)', async () => {
    const s = await scenario();
    const { schedulePost } = await import('../src/scheduling/schedule');
    await expect(schedulePost(s.A(s.editor, 'editor'), s.postId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a member without permission cannot approve', async () => {
    const s = await scenario();
    await submitForApproval(s.A(s.editor, 'editor'), s.postId);
    await expect(approve(s.A(s.editor, 'editor'), s.postId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approve(s.A(s.analyst, 'analyst'), s.postId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('no one can approve their OWN post, regardless of role', async () => {
    const s = await scenario({ author: 'approver' }); // the approver authored it
    await submitForApproval(s.A(s.approver, 'approver'), s.postId);
    await expect(approve(s.A(s.approver, 'approver'), s.postId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  // (a)
  it('editing a post under review VOIDS the approval (back to draft)', async () => {
    const s = await scenario();
    await submitForApproval(s.A(s.editor, 'editor'), s.postId);
    await updatePost(s.A(s.editor, 'editor'), s.postId, { text: 'reworked' });
    expect(await statusOf(s)).toBe('draft');
    const req = asRows(await withTenant(s.A(s.owner, 'owner'), (tx) => tx.execute(sql`select 1 from approval_requests where post_id = ${s.postId} and status = 'pending'`)));
    expect(req).toHaveLength(0); // no pending request remains
  });

  // (b)
  it('removing the approver does not strand the post — the Owner can still approve', async () => {
    const s = await scenario();
    await submitForApproval(s.A(s.editor, 'editor'), s.postId);
    await withTenant(s.A(s.owner, 'owner'), (tx) => tx.execute(sql`delete from memberships where workspace_id = ${s.workspaceId} and user_id = ${s.approver}`));
    const r = await approve(s.A(s.owner, 'owner'), s.postId); // owner is not the author, can approve
    expect(r.status).toBe('scheduled');
  });

  // (c)
  it('a scheduled time that lapsed while unapproved blocks approval', async () => {
    const s = await scenario({ schedule: 'past' });
    await submitForApproval(s.A(s.editor, 'editor'), s.postId);
    await expect(approve(s.A(s.approver, 'approver'), s.postId)).rejects.toBeInstanceOf(ApprovalError);
    expect(await statusOf(s)).toBe('pending_approval'); // still awaiting a valid time
  });

  // (d)
  it('a paid promotion needs two DISTINCT approvers', async () => {
    const s = await scenario({ paid: true });
    await submitForApproval(s.A(s.editor, 'editor'), s.postId);

    const first = await approve(s.A(s.approver, 'approver'), s.postId);
    expect(first.status).toBe('pending_approval'); // 1 of 2
    const dup = await approve(s.A(s.approver, 'approver'), s.postId);
    expect(dup.status).toBe('pending_approval'); // same approver can't count twice
    expect(await statusOf(s)).toBe('pending_approval');

    const second = await approve(s.A(s.approver2, 'approver'), s.postId);
    expect(second.status).toBe('scheduled'); // 2 distinct approvers
    expect(await statusOf(s)).toBe('scheduled');
  });
});
