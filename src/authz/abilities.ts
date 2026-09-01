// src/authz/abilities.ts
// The permission layer as an explicit ability map: (action -> role -> grant), where a grant is
// either `true` or a condition on the resource. No role checks are scattered through controllers;
// services call authorize()/can(). Lifecycle-state gates (e.g. "can't edit a published post")
// live in the domain state machine, NOT here — this layer decides role + ownership only.

export type Role = 'owner' | 'approver' | 'editor' | 'analyst';

export interface Actor { userId: string; role: Role }
// Minimal resource shape the conditions read. Missing fields => the condition fails closed.
export interface Resource { authorId?: string; uploadedById?: string }

export type Action =
  | 'workspace:view' | 'workspace:update' | 'workspace:delete'
  | 'member:view' | 'member:invite' | 'member:change_role' | 'member:remove' | 'member:transfer_ownership'
  | 'billing:view' | 'billing:manage'
  | 'account:connect' | 'account:view' | 'account:disconnect'
  | 'post:create' | 'post:view' | 'post:view_drafts' | 'post:update' | 'post:delete'
  | 'post:submit_for_approval' | 'post:schedule' | 'post:publish_now' | 'post:cancel'
  | 'approval:approve' | 'approval:request_changes'
  | 'queue_slot:view' | 'queue_slot:manage'
  | 'media:upload' | 'media:view' | 'media:delete'
  | 'api_key:view' | 'api_key:create' | 'api_key:revoke'
  | 'webhook:view' | 'webhook:create' | 'webhook:delete'
  | 'analytics:view'
  | 'audit_log:view';

type Condition = (actor: Actor, resource?: Resource) => boolean;
type Grant = true | Condition;

const isOwnPost: Condition = (a, r) => r?.authorId !== undefined && r.authorId === a.userId;
const isOwnMedia: Condition = (a, r) => r?.uploadedById !== undefined && r.uploadedById === a.userId;
// No one approves their own post. Fail closed if authorship is unknown.
const notOwnPost: Condition = (a, r) => r?.authorId !== undefined && r.authorId !== a.userId;

function all(): Partial<Record<Role, Grant>> {
  return { owner: true, approver: true, editor: true, analyst: true };
}

const MATRIX: Record<Action, Partial<Record<Role, Grant>>> = {
  'workspace:view':   all(),
  'workspace:update': { owner: true },
  'workspace:delete': { owner: true },

  'member:view':              all(),
  'member:invite':            { owner: true },
  'member:change_role':       { owner: true },
  'member:remove':            { owner: true },
  'member:transfer_ownership':{ owner: true },

  'billing:view':   { owner: true },
  'billing:manage': { owner: true },

  'account:connect':    { owner: true, approver: true },
  'account:view':       all(),
  'account:disconnect': { owner: true, approver: true },

  'post:create':              { owner: true, approver: true, editor: true },
  'post:view':                all(),
  'post:view_drafts':         { owner: true, approver: true, editor: true }, // Analyst DENIED (rule 5)
  'post:update':              { owner: true, approver: true, editor: isOwnPost },
  'post:delete':              { owner: true, approver: true, editor: isOwnPost },
  'post:submit_for_approval': { owner: true, approver: true, editor: isOwnPost },
  'post:schedule':            { owner: true, approver: true },               // Editor DENIED: must route via approval
  'post:publish_now':         { owner: true, approver: true },
  'post:cancel':              { owner: true, approver: true, editor: isOwnPost },

  'approval:approve':         { owner: notOwnPost, approver: notOwnPost },   // never self-approve
  'approval:request_changes': { owner: true, approver: true },

  'queue_slot:view':   all(),
  'queue_slot:manage': { owner: true, approver: true },

  'media:upload': { owner: true, approver: true, editor: true },
  'media:view':   all(),
  'media:delete': { owner: true, approver: true, editor: isOwnMedia },

  'api_key:view':   { owner: true },
  'api_key:create': { owner: true },
  'api_key:revoke': { owner: true },

  'webhook:view':   { owner: true },
  'webhook:create': { owner: true },
  'webhook:delete': { owner: true },

  'analytics:view': all(),
  'audit_log:view': { owner: true },
};

export function can(actor: Actor, action: Action, resource?: Resource): boolean {
  const grant = MATRIX[action]?.[actor.role];
  if (grant === undefined) return false;
  if (grant === true) return true;
  return grant(actor, resource);
}

// In-tenant permission failure -> 403. Cross-tenant never reaches here: RLS makes the resource
// invisible, the lookup returns nothing, and the API answers 404 (never confirming existence).
export class ForbiddenError extends Error {
  constructor(public action: Action) { super(`forbidden: ${action}`); this.name = 'ForbiddenError'; }
}
export function authorize(actor: Actor, action: Action, resource?: Resource): void {
  if (!can(actor, action, resource)) throw new ForbiddenError(action);
}

export { MATRIX };
