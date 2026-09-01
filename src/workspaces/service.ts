// src/workspaces/service.ts
import { sql } from 'drizzle-orm';
import { db } from '../db/index';
import { withUser, withTenant } from '../db/tenant';
import { authorize, type Actor, type Role } from '../authz/abilities';
import { generateOpaqueToken, hashToken } from '../auth/tokens';
import { writeAudit } from '../audit/audit';

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
  console.info(`[email:invite] -> ${email}`, { token }); // Phase 8 wires real delivery.
}

// --- creation & switching (user-scoped, no existing workspace context) ---

export async function createWorkspace(userId: string, name: string, meta: Meta = {}) {
  return withUser(userId, async (tx) => {
    const slug = `${slugify(name)}-${generateOpaqueToken(4)}`;
    const ws = rows<{ id: string }>(await tx.execute(sql`
      insert into workspaces (name, slug, created_by) values (${name}, ${slug}, ${userId}) returning id
    `));
    const workspaceId = ws[0].id;
    // Establish tenant context for the just-created workspace so the owner-membership insert
    // satisfies the memberships WITH CHECK (workspace_id = app.workspace_id).
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    await tx.execute(sql`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${userId}, 'owner')`);
    await writeAudit(tx, { workspaceId, workspaceSlug: slug, actorUserId: userId, action: 'workspace.created', targetType: 'workspace', targetId: workspaceId, after: { name, slug }, ip: meta.ip, userAgent: meta.userAgent });
    await writeAudit(tx, { workspaceId, actorUserId: userId, action: 'membership.added', targetType: 'user', targetId: userId, after: { role: 'owner' }, ip: meta.ip, userAgent: meta.userAgent });
    return { workspaceId, slug };
  });
}

export async function listMyWorkspaces(userId: string) {
  return withUser(userId, (tx) =>
    tx.execute(sql`
      select w.id, w.name, w.slug, m.role from workspaces w
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
