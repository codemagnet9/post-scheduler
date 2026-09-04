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
import { pgArray } from '../db/index';
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
  // A bounce MUST tell the editor what to change — an empty note is refused server-side (the UI also
  // disables the button, but the rule lives here so it can't be bypassed).
  if (!note || !note.trim()) throw new ApprovalError('note_required');
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

// The approvals inbox read model. Reviewers (Owner/Approver) see every pending post; an Editor sees
// only their own submissions (so they can watch status, but the approve/request-changes ACTIONS are
// still server-gated + UI-hidden); an Analyst sees nothing. Each row carries the four awkward cases,
// so the UI can make them legible: edited-since-submit (Phase 8 voids the approval), the scheduled
// time having lapsed, the two-approver "who's approved / who's still owed", and any approver or
// requester who was removed from the workspace mid-request.
export interface ApprovalApprover { approverId: string | null; name: string | null; email: string | null; isMember: boolean }
export interface ApprovalItem {
  postId: string;
  authorId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  submittedAt: string | null;
  updatedAt: string | null;
  editedSinceSubmit: boolean;
  isPaidPromotion: boolean;
  requiredApprovals: number;
  approvals: ApprovalApprover[];
  requesterId: string | null;
  requesterName: string | null;
  requesterIsMember: boolean;
  scheduleType: string | null;
  scheduledAt: string | null;
  schedulePassed: boolean;
}

export async function listApprovals(actor: ScopedActor): Promise<ApprovalItem[]> {
  const reviewer = actor.role === 'owner' || actor.role === 'approver';
  if (!reviewer && actor.role !== 'editor') return []; // analyst: nothing
  return withTenant(ctxOf(actor), async (tx) => {
    authorize(actor, 'post:view_drafts'); // editors+ only; analyst is denied and returns [] above
    const posts = rows<{ post_id: string; author_id: string | null; author_name: string | null; author_email: string | null; is_paid_promotion: boolean; updated_at: string; schedule_type: string | null; scheduled_at: string | null; submitted_at: string; requested_by: string | null; requester_name: string | null }>(await tx.execute(sql`
      select p.id as post_id, p.author_id, au.name as author_name, au.email as author_email,
             p.is_paid_promotion, p.updated_at, p.schedule_type, p.scheduled_at,
             ar.created_at as submitted_at, ar.requested_by, ru.name as requester_name
      from posts p
      join approval_requests ar on ar.post_id = p.id and ar.status = 'pending'
      left join users au on au.id = p.author_id
      left join users ru on ru.id = ar.requested_by
      where p.status = 'pending_approval'
        ${reviewer ? sql`` : sql`and p.author_id = ${actor.userId}`}
      order by ar.created_at
    `));
    if (!posts.length) return [];

    const decisions = rows<{ post_id: string; approver_id: string | null; name: string | null; email: string | null; is_member: boolean }>(await tx.execute(sql`
      select ad.post_id, ad.approver_id, u.name, u.email, (m.user_id is not null) as is_member
      from approval_decisions ad
      left join users u on u.id = ad.approver_id
      left join memberships m on m.user_id = ad.approver_id and m.workspace_id = ${actor.workspaceId}
      where ad.decision = 'approved' and ad.post_id = any(${pgArray(posts.map((p) => p.post_id))}::uuid[])
    `));
    const members = new Set(rows<{ user_id: string }>(await tx.execute(sql`select user_id from memberships where workspace_id = ${actor.workspaceId}`)).map((r) => r.user_id));

    const now = Date.now();
    return posts.map((p) => {
      const submittedAt = p.submitted_at ? new Date(p.submitted_at).toISOString() : null;
      const updatedAt = p.updated_at ? new Date(p.updated_at).toISOString() : null;
      // A 2s grace absorbs the submit's own updated_at write; a real later edit exceeds it.
      const editedSinceSubmit = !!(submittedAt && updatedAt && new Date(updatedAt).getTime() > new Date(submittedAt).getTime() + 2000);
      const scheduledAt = p.scheduled_at ? new Date(p.scheduled_at).toISOString() : null;
      const schedulePassed = p.schedule_type === 'fixed_instant' && scheduledAt != null && new Date(scheduledAt).getTime() <= now;
      return {
        postId: p.post_id, authorId: p.author_id, authorName: p.author_name, authorEmail: p.author_email,
        submittedAt, updatedAt, editedSinceSubmit,
        isPaidPromotion: p.is_paid_promotion, requiredApprovals: p.is_paid_promotion ? 2 : 1,
        approvals: decisions.filter((d) => d.post_id === p.post_id).map((d) => ({ approverId: d.approver_id, name: d.name, email: d.email, isMember: d.is_member })),
        requesterId: p.requested_by, requesterName: p.requester_name, requesterIsMember: p.requested_by ? members.has(p.requested_by) : false,
        scheduleType: p.schedule_type, scheduledAt, schedulePassed,
      };
    });
  });
}
