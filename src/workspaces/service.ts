// src/workspaces/service.ts
import { sql } from 'drizzle-orm';
import { db } from '../db/index';
import { withUser, withTenant } from '../db/tenant';
import { authorize, type Actor, type Role } from '../authz/abilities';
import { generateOpaqueToken, hashToken } from '../auth/tokens';
import { writeAudit } from '../audit/audit';
import { getEmailProvider } from '../notifications/email';

export class WorkspaceError extends Error {
  constructor(code: string) { super(code); this.name = 'WorkspaceError'; }
}

// An actor bound to a workspace: exactly what the API's tenant resolver produces.
export type ScopedActor = Actor & { workspaceId: string };
export interface Meta { ip?: string; userAgent?: string }

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 32) || 'workspace';
}

async function sendInviteEmail(email: string, token: string): Promise<void> {
  const link = `${process.env.APP_URL ?? ''}/invitations/accept?token=${token}`;
  await getEmailProvider().send({ to: email, subject: "You've been invited to a workspace", text: `Join the workspace:\n\n${link}` }).catch(() => undefined);
}

// --- creation & switching (user-scoped, no existing workspace context) ---

// opts carries the request meta AND the chosen primary-market timezone (the signup "primary market").
// Kept as an options object so the route can still pass { ip, userAgent } and older callers pass nothing.
export async function createWorkspace(userId: string, name: string, opts: { timezone?: string; ip?: string; userAgent?: string } = {}) {
  return withUser(userId, async (tx) => {
    const slug = `${slugify(name)}-${generateOpaqueToken(4)}`;
    const ws = rows<{ id: string }>(await tx.execute(sql`
      insert into workspaces (name, slug, default_timezone, created_by) values (${name}, ${slug}, ${opts.timezone ?? 'UTC'}, ${userId}) returning id
    `));
    const workspaceId = ws[0].id;
    // Establish tenant context for the just-created workspace so the owner-membership insert
    // satisfies the memberships WITH CHECK (workspace_id = app.workspace_id).
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    await tx.execute(sql`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${userId}, 'owner')`);
    await writeAudit(tx, { workspaceId, workspaceSlug: slug, actorUserId: userId, action: 'workspace.created', targetType: 'workspace', targetId: workspaceId, after: { name, slug }, ip: opts.ip, userAgent: opts.userAgent });
    await writeAudit(tx, { workspaceId, actorUserId: userId, action: 'membership.added', targetType: 'user', targetId: userId, after: { role: 'owner' }, ip: opts.ip, userAgent: opts.userAgent });
    return { workspaceId, slug };
  });
}

export async function listMyWorkspaces(userId: string) {
  return withUser(userId, (tx) =>
    tx.execute(sql`
      select w.id, w.name, w.slug, w.default_timezone, m.role from workspaces w
      join memberships m on m.workspace_id = w.id and m.user_id = ${userId}
      where w.deleted_at is null order by w.created_at
    `),
  );
}

export async function acceptInvite(userId: string, rawToken: string) {
  return withUser(userId, async (tx) => {
    // app_accept_invitation is SECURITY DEFINER: it validates the token and inserts the membership
    // even though the invitee cannot yet see the invitation under RLS. It RAISES if invalid.
    const r = rows<{ workspace_id: string; role: Role }>(await tx.execute(sql`
      select workspace_id, role from app_accept_invitation(${hashToken(rawToken)}, ${userId})
    `));
    if (!r.length) throw new WorkspaceError('invitation_invalid');
    const { workspace_id, role } = r[0];
    await tx.execute(sql`select set_config('app.workspace_id', ${workspace_id}, true)`);
    await writeAudit(tx, { workspaceId: workspace_id, actorUserId: userId, action: 'membership.added', targetType: 'user', targetId: userId, after: { role } });
    return { workspaceId: workspace_id, role };
  });
}

// --- membership management (tenant-scoped) ---

export async function inviteMember(actor: ScopedActor, email: string, role: Role, meta: Meta = {}) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'member:invite');
    const token = generateOpaqueToken();
    const inv = rows<{ id: string }>(await tx.execute(sql`
      insert into invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
      values (${actor.workspaceId}, ${email}, ${role}, ${hashToken(token)}, ${actor.userId}, now() + interval '7 days')
      returning id
    `));
    await writeAudit(tx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: 'invitation.created', targetType: 'invitation', targetId: inv[0].id, after: { email, role }, ip: meta.ip, userAgent: meta.userAgent });
    await sendInviteEmail(email, token);
    return { invitationId: inv[0].id };
  });
}

// Locks the workspace's owner rows first, so two concurrent demotions cannot both observe 2 owners
// and each demote — the classic way a workspace ends up with zero Owners.
async function lockOwners(tx: Parameters<Parameters<typeof withTenant>[1]>[0], workspaceId: string): Promise<string[]> {
  const r = rows<{ user_id: string }>(await tx.execute(sql`
    select user_id from memberships where workspace_id = ${workspaceId} and role = 'owner' for update
  `));
  return r.map((x) => x.user_id);
}

export async function changeRole(actor: ScopedActor, targetUserId: string, newRole: Role, meta: Meta = {}) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'member:change_role');
    const owners = await lockOwners(tx, actor.workspaceId);
    const cur = rows<{ role: Role }>(await tx.execute(sql`
      select role from memberships where workspace_id = ${actor.workspaceId} and user_id = ${targetUserId}
    `));
    if (!cur.length) throw new WorkspaceError('member_not_found');
    if (cur[0].role === 'owner' && newRole !== 'owner' && owners.length <= 1) throw new WorkspaceError('last_owner');
    await tx.execute(sql`update memberships set role = ${newRole} where workspace_id = ${actor.workspaceId} and user_id = ${targetUserId}`);
    await writeAudit(tx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: 'membership.role_changed', targetType: 'user', targetId: targetUserId, before: { role: cur[0].role }, after: { role: newRole }, ip: meta.ip, userAgent: meta.userAgent });
  });
}

export async function removeMember(actor: ScopedActor, targetUserId: string, meta: Meta = {}) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'member:remove');
    const owners = await lockOwners(tx, actor.workspaceId);
    const cur = rows<{ role: Role }>(await tx.execute(sql`
      select role from memberships where workspace_id = ${actor.workspaceId} and user_id = ${targetUserId}
    `));
    if (!cur.length) throw new WorkspaceError('member_not_found');
    if (cur[0].role === 'owner' && owners.length <= 1) throw new WorkspaceError('last_owner');
    await tx.execute(sql`delete from memberships where workspace_id = ${actor.workspaceId} and user_id = ${targetUserId}`);
    await writeAudit(tx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: 'membership.removed', targetType: 'user', targetId: targetUserId, before: { role: cur[0].role }, ip: meta.ip, userAgent: meta.userAgent });
  });
}

// Leaving is allowed for any role (no authorize()), but the last Owner cannot strand the workspace.
export async function leaveWorkspace(actor: ScopedActor) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const owners = await lockOwners(tx, actor.workspaceId);
    const cur = rows<{ role: Role }>(await tx.execute(sql`
      select role from memberships where workspace_id = ${actor.workspaceId} and user_id = ${actor.userId}
    `));
    if (!cur.length) throw new WorkspaceError('not_a_member');
    if (cur[0].role === 'owner' && owners.length <= 1) throw new WorkspaceError('last_owner');
    await tx.execute(sql`delete from memberships where workspace_id = ${actor.workspaceId} and user_id = ${actor.userId}`);
    await writeAudit(tx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: 'membership.left', targetType: 'user', targetId: actor.userId, before: { role: cur[0].role } });
  });
}

// --- read models & settings for the Team + Settings screens (tenant-scoped) ---

export interface MemberRow { userId: string; name: string | null; email: string; role: Role; joinedAt: string; lastActiveAt: string | null }
// The Team screen's members table. last-active = the most recent session touch across the user's
// sessions (sessions has no RLS and is keyed by user, so it's read outside the tenant policy).
export async function listMembers(actor: ScopedActor): Promise<MemberRow[]> {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'member:view');
    const r = rows<{ user_id: string; name: string | null; email: string; role: Role; created_at: string; last_active_at: string | null }>(await tx.execute(sql`
      select m.user_id, u.name, u.email, m.role, m.created_at,
             (select max(s.last_used_at) from sessions s where s.user_id = m.user_id) as last_active_at
      from memberships m join users u on u.id = m.user_id
      where m.workspace_id = ${actor.workspaceId}
      order by m.created_at
    `));
    return r.map((m) => ({
      userId: m.user_id, name: m.name, email: m.email, role: m.role,
      joinedAt: new Date(m.created_at).toISOString(),
      lastActiveAt: m.last_active_at ? new Date(m.last_active_at).toISOString() : null,
    }));
  });
}

export interface InvitationRow { id: string; email: string; role: Role; invitedBy: string | null; createdAt: string; expiresAt: string }
// Pending invites, shown as their own rows in the Team table (a fresh invite must appear immediately).
export async function listInvitations(actor: ScopedActor): Promise<InvitationRow[]> {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'member:view');
    const r = rows<{ id: string; email: string; role: Role; invited_by: string | null; created_at: string; expires_at: string }>(await tx.execute(sql`
      select id, email, role, invited_by, created_at, expires_at from invitations
      where workspace_id = ${actor.workspaceId} and status = 'pending' and expires_at > now()
      order by created_at desc
    `));
    return r.map((i) => ({
      id: i.id, email: i.email, role: i.role, invitedBy: i.invited_by,
      createdAt: new Date(i.created_at).toISOString(),
      expiresAt: new Date(i.expires_at).toISOString(),
    }));
  });
}

export interface WorkspaceDetail { id: string; name: string; slug: string; defaultTimezone: string; planTier: string; settings: Record<string, unknown> }
export async function getWorkspace(actor: ScopedActor): Promise<WorkspaceDetail> {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'workspace:view');
    const r = rows<{ id: string; name: string; slug: string; default_timezone: string; plan_tier: string; settings: Record<string, unknown> | null }>(await tx.execute(sql`
      select id, name, slug, default_timezone, plan_tier, settings from workspaces where id = ${actor.workspaceId} and deleted_at is null
    `));
    if (!r.length) throw new WorkspaceError('not_found');
    const w = r[0];
    return { id: w.id, name: w.name, slug: w.slug, defaultTimezone: w.default_timezone, planTier: w.plan_tier, settings: w.settings ?? {} };
  });
}

// Update workspace name / default timezone / free-form settings. Settings are MERGED (jsonb ||), so a
// PATCH that carries only { weekStart } never clobbers unrelated posting-default toggles.
export async function updateWorkspace(actor: ScopedActor, patch: { name?: string; timezone?: string; settings?: Record<string, unknown> }, meta: Meta = {}) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'workspace:update');
    const before = rows<{ name: string; default_timezone: string; settings: Record<string, unknown> | null }>(await tx.execute(sql`
      select name, default_timezone, settings from workspaces where id = ${actor.workspaceId} and deleted_at is null for update
    `));
    if (!before.length) throw new WorkspaceError('not_found');
    if (patch.name !== undefined && !patch.name.trim()) throw new WorkspaceError('name_required');
    if (patch.name !== undefined) await tx.execute(sql`update workspaces set name = ${patch.name.trim()} where id = ${actor.workspaceId}`);
    if (patch.timezone !== undefined) await tx.execute(sql`update workspaces set default_timezone = ${patch.timezone} where id = ${actor.workspaceId}`);
    if (patch.settings !== undefined) await tx.execute(sql`update workspaces set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify(patch.settings)}::jsonb where id = ${actor.workspaceId}`);
    await writeAudit(tx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: 'workspace.updated', targetType: 'workspace', targetId: actor.workspaceId, before: { name: before[0].name, timezone: before[0].default_timezone }, after: { name: patch.name, timezone: patch.timezone, settings: patch.settings }, ip: meta.ip, userAgent: meta.userAgent });
    return getWorkspaceInTx(tx, actor.workspaceId);
  });
}

// Soft-delete (sets deleted_at). Only an Owner can, and the workspace must still exist. The API layer
// requires the caller to type the workspace name to confirm; the name check is enforced there.
export async function deleteWorkspace(actor: ScopedActor, meta: Meta = {}) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'workspace:delete');
    const r = rows<{ id: string; slug: string }>(await tx.execute(sql`
      update workspaces set deleted_at = now() where id = ${actor.workspaceId} and deleted_at is null returning id, slug
    `));
    if (!r.length) throw new WorkspaceError('not_found');
    await writeAudit(tx, { workspaceId: actor.workspaceId, workspaceSlug: r[0].slug, actorUserId: actor.userId, action: 'workspace.deleted', targetType: 'workspace', targetId: actor.workspaceId, ip: meta.ip, userAgent: meta.userAgent });
    return { deleted: true as const };
  });
}

async function getWorkspaceInTx(tx: Parameters<Parameters<typeof withTenant>[1]>[0], workspaceId: string): Promise<WorkspaceDetail> {
  const r = rows<{ id: string; name: string; slug: string; default_timezone: string; plan_tier: string; settings: Record<string, unknown> | null }>(await tx.execute(sql`
    select id, name, slug, default_timezone, plan_tier, settings from workspaces where id = ${workspaceId}
  `));
  const w = r[0];
  return { id: w.id, name: w.name, slug: w.slug, defaultTimezone: w.default_timezone, planTier: w.plan_tier, settings: w.settings ?? {} };
}

// Promote the target to Owner BEFORE stepping the initiator down, so an Owner always exists.
export async function transferOwnership(actor: ScopedActor, toUserId: string, meta: Meta = {}) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'member:transfer_ownership');
    await lockOwners(tx, actor.workspaceId);
    const target = rows<{ role: Role }>(await tx.execute(sql`
      select role from memberships where workspace_id = ${actor.workspaceId} and user_id = ${toUserId}
    `));
    if (!target.length) throw new WorkspaceError('member_not_found');
    await tx.execute(sql`update memberships set role = 'owner' where workspace_id = ${actor.workspaceId} and user_id = ${toUserId}`);
    await tx.execute(sql`update memberships set role = 'approver' where workspace_id = ${actor.workspaceId} and user_id = ${actor.userId} and role = 'owner'`);
    await writeAudit(tx, { workspaceId: actor.workspaceId, actorUserId: actor.userId, action: 'workspace.ownership_transferred', targetType: 'user', targetId: toUserId, before: { owner: actor.userId }, after: { owner: toUserId }, ip: meta.ip, userAgent: meta.userAgent });
  });
}
