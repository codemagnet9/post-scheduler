// src/approvals/service.ts
// The approval flow. An Editor submits (draft -> pending_approval); an Approver approves (-> schedules
// via the shared materializeAndSchedule path) or requests changes (-> changes_requested). Editors
// can't reach schedulePost (post:schedule denied), so review cannot be bypassed.
//
// Awkward cases, and the rule for each:
//  (a) post edited while under review -> the approval is VOID (handled in posts/service.updatePost:
//      the post returns to draft and the request is canceled).
//  (b) an approver removed from the workspace while a request is pending -> nothing is stranded: any
//      current Approver OR the Owner can still act (approvals aren't assigned to one person, and a
//      workspace always keeps >=1 Owner who can approve).
//  (c) the scheduled time lapses while the post sits unapproved -> validation's schedule_in_past
//      blocker fires when approve() tries to schedule, so approval is refused until it's rescheduled.
//  (d) a paid promotion requires TWO distinct approvers -> is_paid_promotion posts stay pending until
//      two different approvers have each approved; the same approver can't count twice.
import { sql } from 'drizzle-orm';
import { withTenant } from '../db/tenant';
import { authorize, type Actor } from '../authz/abilities';
import { emitEvent } from '../events/emit';
import { materializeAndSchedule } from '../scheduling/schedule';
import { validatePostService } from '../posts/service';

export class ApprovalError extends Error {
  constructor(code: string) { super(code); this.name = 'ApprovalError'; }
}
export type ScopedActor = Actor & { workspaceId: string };
type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
const ctxOf = (a: ScopedActor) => ({ workspaceId: a.workspaceId, userId: a.userId, role: a.role });

export async function submitForApproval(actor: ScopedActor, postId: string) {
  return withTenant(ctxOf(actor), async (tx) => {
    const p = rows<{ author_id: string | null; status: string }>(await tx.execute(sql`select author_id, status from posts where id = ${postId}`))[0];
    if (!p) throw new ApprovalError('not_found');
    authorize(actor, 'post:submit_for_approval', { authorId: p.author_id ?? undefined });
    if (p.status !== 'draft' && p.status !== 'changes_requested') throw new ApprovalError('not_submittable');

    await tx.execute(sql`update posts set status = 'pending_approval', updated_at = now() where id = ${postId}`);
    const open = rows(await tx.execute(sql`select 1 from approval_requests where post_id = ${postId} and status = 'pending'`));
    if (!open.length) {
      await tx.execute(sql`insert into approval_requests (post_id, workspace_id, requested_by, status) values (${postId}, ${actor.workspaceId}, ${actor.userId}, 'pending')`);
    }
    await emitEvent(tx, { workspaceId: actor.workspaceId, aggregateType: 'post', aggregateId: postId, type: 'post.submitted', payload: { requestedBy: actor.userId } });
    return { status: 'pending_approval' as const };
  });
}

export async function approve(actor: ScopedActor, postId: string) {
  // Case (c): validate BEFORE recording anything, so a lapsed schedule refuses approval cleanly.
  const validation = await validatePostService(actor, postId);
  if (!validation.canSchedule) throw new ApprovalError('has_blockers');

  const outcome = await withTenant(ctxOf(actor), async (tx) => {
    const p = rows<{ author_id: string | null; status: string; is_paid_promotion: boolean }>(await tx.execute(sql`select author_id, status, is_paid_promotion from posts where id = ${postId}`))[0];
    if (!p) throw new ApprovalError('not_found');
    authorize(actor, 'approval:approve', { authorId: p.author_id ?? undefined }); // never your own post
    if (p.status !== 'pending_approval') throw new ApprovalError('not_pending');

    // Record THIS approver's decision (idempotent per approver).
    await tx.execute(sql`insert into approval_decisions (post_id, workspace_id, approver_id, decision) values (${postId}, ${actor.workspaceId}, ${actor.userId}, 'approved') on conflict (post_id, approver_id) do nothing`);
    const required = p.is_paid_promotion ? 2 : 1;
    const approvals = Number(rows<{ c: number }>(await tx.execute(sql`select count(distinct approver_id)::int as c from approval_decisions where post_id = ${postId} and decision = 'approved'`))[0].c);
    if (approvals < required) {
      await emitEvent(tx, { workspaceId: actor.workspaceId, aggregateType: 'post', aggregateId: postId, type: 'post.approval_recorded', payload: { approvals, required } });
      return { done: false as const, approvals, required };
    }
    return { done: true as const, authorId: p.author_id };
  });

  if (!outcome.done) return { status: 'pending_approval' as const, approvals: outcome.approvals, required: outcome.required };

  await materializeAndSchedule(actor, postId); // schedules (re-validates)
  await withTenant(ctxOf(actor), async (tx) => {
    await tx.execute(sql`update approval_requests set status = 'approved', decided_by = ${actor.userId}, decided_at = now() where post_id = ${postId} and status = 'pending'`);
    await emitEvent(tx, { workspaceId: actor.workspaceId, aggregateType: 'post', aggregateId: postId, type: 'post.approved', payload: { authorId: outcome.authorId } });
  });
  return { status: 'scheduled' as const };
}

export async function requestChanges(actor: ScopedActor, postId: string, note?: string) {
  return withTenant(ctxOf(actor), async (tx) => {
    const p = rows<{ author_id: string | null; status: string }>(await tx.execute(sql`select author_id, status from posts where id = ${postId}`))[0];
    if (!p) throw new ApprovalError('not_found');
    authorize(actor, 'approval:request_changes');
    if (p.status !== 'pending_approval') throw new ApprovalError('not_pending');

    await tx.execute(sql`update posts set status = 'changes_requested', updated_at = now() where id = ${postId}`);
    await tx.execute(sql`update approval_requests set status = 'changes_requested', decided_by = ${actor.userId}, decided_at = now(), note = ${note ?? null} where post_id = ${postId} and status = 'pending'`);
    await tx.execute(sql`delete from approval_decisions where post_id = ${postId}`); // a bounce clears any recorded approvals
    await emitEvent(tx, { workspaceId: actor.workspaceId, aggregateType: 'post', aggregateId: postId, type: 'post.changes_requested', payload: { authorId: p.author_id, note: note ?? null } });
    return { status: 'changes_requested' as const };
  });
}
