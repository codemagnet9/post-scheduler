// test/authz.test.ts
// Pure unit tests over the ability map — no DB. These are the fast guardrails on the matrix.
import { describe, it, expect } from 'vitest';
import { can, authorize, ForbiddenError, type Role, type Action } from '../src/authz/abilities';

const WRITE_ACTIONS: Action[] = [
  'workspace:update', 'workspace:delete',
  'member:invite', 'member:change_role', 'member:remove', 'member:transfer_ownership',
  'billing:manage', 'account:connect', 'account:disconnect',
  'post:create', 'post:update', 'post:delete', 'post:submit_for_approval',
  'post:schedule', 'post:publish_now', 'post:cancel',
  'approval:approve', 'approval:request_changes',
  'queue_slot:manage', 'media:upload', 'media:delete',
  'api_key:create', 'api_key:revoke', 'webhook:create', 'webhook:delete',
];

describe('permission matrix', () => {
  it('an Analyst is refused EVERY write action', () => {
    for (const action of WRITE_ACTIONS) {
      expect(can({ userId: 'u', role: 'analyst' }, action, { authorId: 'u', uploadedById: 'u' })).toBe(false);
    }
  });

  it('an Analyst sees analytics but never drafts', () => {
    expect(can({ userId: 'u', role: 'analyst' }, 'analytics:view')).toBe(true);
    expect(can({ userId: 'u', role: 'analyst' }, 'post:view_drafts')).toBe(false);
    expect(can({ userId: 'u', role: 'analyst' }, 'post:view')).toBe(true); // published/scheduled only
  });

  it('an Editor cannot schedule directly and must route through approval', () => {
    expect(can({ userId: 'e', role: 'editor' }, 'post:schedule')).toBe(false);
    expect(can({ userId: 'e', role: 'editor' }, 'post:publish_now')).toBe(false);
    expect(can({ userId: 'e', role: 'editor' }, 'post:submit_for_approval', { authorId: 'e' })).toBe(true);
  });

  it('no one may approve their own post — Approver or Owner', () => {
    expect(can({ userId: 'p', role: 'approver' }, 'approval:approve', { authorId: 'p' })).toBe(false);
    expect(can({ userId: 'p', role: 'approver' }, 'approval:approve', { authorId: 'other' })).toBe(true);
    expect(can({ userId: 'o', role: 'owner' }, 'approval:approve', { authorId: 'o' })).toBe(false);
    // Fail closed when authorship is unknown.
    expect(can({ userId: 'p', role: 'approver' }, 'approval:approve')).toBe(false);
  });

  it('an Editor edits/deletes only their own content', () => {
    expect(can({ userId: 'e', role: 'editor' }, 'post:update', { authorId: 'e' })).toBe(true);
    expect(can({ userId: 'e', role: 'editor' }, 'post:update', { authorId: 'other' })).toBe(false);
    expect(can({ userId: 'e', role: 'editor' }, 'media:delete', { uploadedById: 'e' })).toBe(true);
    expect(can({ userId: 'e', role: 'editor' }, 'media:delete', { uploadedById: 'other' })).toBe(false);
  });

  it('only the Owner touches accounts-management, API keys, billing, and audit', () => {
    for (const r of ['approver', 'editor', 'analyst'] as Role[]) {
      expect(can({ userId: 'u', role: r }, 'api_key:create')).toBe(false);
      expect(can({ userId: 'u', role: r }, 'api_key:revoke')).toBe(false);
      expect(can({ userId: 'u', role: r }, 'billing:view')).toBe(false);
      expect(can({ userId: 'u', role: r }, 'audit_log:view')).toBe(false);
      expect(can({ userId: 'u', role: r }, 'webhook:create')).toBe(false);
    }
    expect(can({ userId: 'o', role: 'owner' }, 'api_key:create')).toBe(true);
  });

  it('connect/disconnect an account: Owner + Approver only', () => {
    expect(can({ userId: 'u', role: 'approver' }, 'account:connect')).toBe(true);
    expect(can({ userId: 'u', role: 'editor' }, 'account:connect')).toBe(false);
    expect(can({ userId: 'u', role: 'analyst' }, 'account:view')).toBe(true);
  });

  it('changing queue slots: Owner + Approver only (Editors use slots, not define them)', () => {
    expect(can({ userId: 'u', role: 'approver' }, 'queue_slot:manage')).toBe(true);
    expect(can({ userId: 'u', role: 'editor' }, 'queue_slot:manage')).toBe(false);
    expect(can({ userId: 'u', role: 'editor' }, 'queue_slot:view')).toBe(true);
  });

  it('authorize() throws ForbiddenError on denial', () => {
    expect(() => authorize({ userId: 'u', role: 'analyst' }, 'post:create')).toThrow(ForbiddenError);
    expect(() => authorize({ userId: 'e', role: 'editor' }, 'approval:approve', { authorId: 'e' })).toThrow(ForbiddenError);
  });
});
