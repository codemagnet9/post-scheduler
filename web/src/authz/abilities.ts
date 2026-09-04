// src/authz/abilities.ts
// A faithful MIRROR of the server's ability matrix (src/authz/abilities.ts), for gating what the UI
// even renders. The server is still the single source of truth — every gated action is re-checked
// there — but an action a role can't perform must not appear in the DOM at all (an Editor never sees an
// Approve button, not even a disabled/CSS-hidden one). Keeping this as an explicit map, rather than
// scattering `role === 'owner'` through components, is what makes that auditable and testable.
import type { Role } from '../api/types';

export type Action =
  | 'workspace:update' | 'workspace:delete'
  | 'member:invite' | 'member:change_role' | 'member:remove' | 'member:transfer_ownership'
  | 'billing:view'
  | 'approval:approve' | 'approval:request_changes';

// A resource condition mirrors the server's (e.g. "never approve your own post"). Fails closed when
// the fields it needs are absent.
export interface AbilityResource { authorId?: string | null }
type Condition = (userId: string, resource?: AbilityResource) => boolean;
type Grant = true | Condition;

// No one approves their own post — matches the server's notOwnPost condition exactly.
const notOwnPost: Condition = (userId, r) => r?.authorId != null && r.authorId !== userId;

const MATRIX: Record<Action, Partial<Record<Role, Grant>>> = {
  'workspace:update': { owner: true },
  'workspace:delete': { owner: true },

  'member:invite':             { owner: true },
  'member:change_role':        { owner: true },
  'member:remove':             { owner: true },
  'member:transfer_ownership': { owner: true },

  'billing:view': { owner: true },

  'approval:approve':         { owner: notOwnPost, approver: notOwnPost }, // never self-approve
  'approval:request_changes': { owner: true, approver: true },
};

export function can(role: Role, userId: string, action: Action, resource?: AbilityResource): boolean {
  const grant = MATRIX[action]?.[role];
  if (grant === undefined) return false;
  if (grant === true) return true;
  return grant(userId, resource);
}
