// src/screens/app/team/teamLogic.ts
// Pure helpers for the Team screen. Role management is Owner-only (mirrors the server's member:* abilities
// via authz/abilities); the last-Owner invariant is NOT enforced here — that's a server rule, and when
// the server refuses (e.g. demoting the last Owner) the UI renders the refusal reason verbatim rather
// than pre-judging it.
import type { Role } from '../../../api/types';

export const ROLES: Role[] = ['owner', 'approver', 'editor', 'analyst'];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  approver: 'Approver',
  editor: 'Editor',
  analyst: 'Analyst',
};

// What each role can do, in one line, for the invite picker and role tooltips.
export const ROLE_BLURB: Record<Role, string> = {
  owner: 'Full control, including billing, members and workspace settings.',
  approver: 'Compose, schedule, approve others’ posts and manage networks.',
  editor: 'Compose and submit drafts for approval — can’t schedule directly.',
  analyst: 'Read-only: analytics and published posts, no drafts.',
};

// The badge tint per role, reusing the shared badge palette.
export const ROLE_BADGE: Record<Role, string> = {
  owner: 'b-info',
  approver: 'b-ok',
  editor: 'b-mute',
  analyst: 'b-mute',
};
