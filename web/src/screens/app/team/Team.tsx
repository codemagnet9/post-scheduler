// src/screens/app/team/Team.tsx
// Members + invitations. Every mutation goes through the server's ability layer (Owner-only for role
// changes, removals and invites); the buttons are only rendered for roles that can use them, but the
// server is still authoritative. The last-Owner invariant is a SERVER rule — when it refuses, we render
// the reason it sends back VERBATIM ("Cannot demote the last Owner"), never a message we made up.
import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../../shell/Screen';
import { useWorkspace, useZonedFormat } from '../../../workspace/WorkspaceProvider';
import { useAuth } from '../../../auth/AuthProvider';
import { can } from '../../../authz/abilities';
import { listMembers, listInvitations, inviteMember, changeMemberRole, removeMember } from '../../../api/endpoints';
import { ApiError } from '../../../api/client';
import { EmptyState, ErrorState, SkeletonRows } from '../../../components/states';
import { Avatar } from '../../../components/Avatar';
import type { Role } from '../../../api/types';
import { ROLES, ROLE_LABEL, ROLE_BLURB, ROLE_BADGE } from './teamLogic';

export function Team(): JSX.Element {
  const { active } = useWorkspace();
  const { user } = useAuth();
  const ws = active.id;
  const fmt = useZonedFormat();
  const qc = useQueryClient();
  const userId = user?.id ?? '';
  const mayManage = can(active.role, userId, 'member:change_role'); // Owner-only; also gates remove/invite

  const membersQ = useQuery({ queryKey: ['members', ws], queryFn: () => listMembers(ws) });
  const invitesQ = useQuery({ queryKey: ['invitations', ws], queryFn: () => listInvitations(ws) });

  // A single place to hold the verbatim server refusal, tagged to the row it belongs to.
  const [rowError, setRowError] = useState<{ userId: string; message: string } | null>(null);
  const clearErr = () => setRowError(null);
  const onRowError = (uid: string) => (e: unknown) => setRowError({ userId: uid, message: e instanceof ApiError ? e.displayMessage : 'Something went wrong.' });

  const roleM = useMutation({
    mutationFn: ({ uid, role }: { uid: string; role: Role }) => changeMemberRole(ws, uid, role),
    onMutate: clearErr,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['members', ws] }); qc.invalidateQueries({ queryKey: ['workspaces'] }); },
  });
  const removeM = useMutation({
    mutationFn: (uid: string) => removeMember(ws, uid),
    onMutate: clearErr,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members', ws] }),
  });

  const members = membersQ.data ?? [];
  const invites = invitesQ.data ?? [];

  return (
    <Screen title="Team">
      {mayManage && <InviteCard ws={ws} onInvited={() => qc.invalidateQueries({ queryKey: ['invitations', ws] })} />}

      <div className="card">
        <div className="card-h">
          <h3>Members</h3>
          <span className="dim sp" style={{ fontSize: 12 }}>{members.length} {members.length === 1 ? 'member' : 'members'}</span>
        </div>
        <div className="card-b flush">
          {membersQ.isLoading ? <SkeletonRows rows={4} />
            : membersQ.error ? <ErrorState error={membersQ.error instanceof ApiError ? membersQ.error : null} onRetry={() => membersQ.refetch()} />
            : members.length === 0 ? <EmptyState icon="⊙" title="No members yet" />
            : (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Member</th><th>Role</th><th>Joined</th><th>Last active</th>
                      {mayManage && <th aria-label="actions" />}
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => {
                      const isSelf = m.userId === userId;
                      return (
                        <tr key={m.userId}>
                          <td>
                            <div className="row" style={{ gap: 10 }}>
                              <Avatar name={m.name ?? m.email} seed={m.userId} size={32} />
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name ?? m.email}{isSelf && <span className="dim" style={{ fontWeight: 400 }}> (you)</span>}</div>
                                <div className="dim" style={{ fontSize: 12 }}>{m.email}</div>
                              </div>
                            </div>
                          </td>
                          <td>
                            {mayManage ? (
                              <select
                                className="inp"
                                style={{ width: 'auto', padding: '7px 10px' }}
                                value={m.role}
                                disabled={roleM.isPending}
                                onChange={(e) => roleM.mutate({ uid: m.userId, role: e.target.value as Role }, { onError: onRowError(m.userId) })}
                                aria-label={`Role for ${m.name ?? m.email}`}
                              >
                                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                              </select>
                            ) : (
                              <span className={`badge ${ROLE_BADGE[m.role]}`}>{ROLE_LABEL[m.role]}</span>
                            )}
                            {rowError?.userId === m.userId && <div className="hint h-bad" style={{ marginTop: 8 }}>{rowError.message}</div>}
                          </td>
                          <td className="dim" style={{ fontSize: 12.5 }}>{fmt.date(m.joinedAt)}</td>
                          <td className="dim" style={{ fontSize: 12.5 }}>{m.lastActiveAt ? fmt.dateTime(m.lastActiveAt) : 'Never'}</td>
                          {mayManage && (
                            <td style={{ textAlign: 'right' }}>
                              <button
                                className="btn btn-danger btn-sm"
                                disabled={removeM.isPending}
                                onClick={() => removeM.mutate(m.userId, { onError: onRowError(m.userId) })}
                              >
                                Remove
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}

                    {/* Pending invitations render as their own rows — a fresh invite appears here immediately. */}
                    {invites.map((inv) => (
                      <tr key={inv.id} style={{ opacity: 0.85 }}>
                        <td>
                          <div className="row" style={{ gap: 10 }}>
                            <Avatar name={inv.email} seed={inv.id} size={32} square />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{inv.email}</div>
                              <div className="dim" style={{ fontSize: 12 }}>Invited · expires {fmt.date(inv.expiresAt)}</div>
                            </div>
                          </div>
                        </td>
                        <td><span className={`badge ${ROLE_BADGE[inv.role]}`}>{ROLE_LABEL[inv.role]}</span></td>
                        <td colSpan={mayManage ? 3 : 2}><span className="badge b-warn">Pending invite</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>
    </Screen>
  );
}

// Invite-by-email. A real API call mints a server-side token; on success the pending-invite row appears
// immediately (the parent refetches invitations). NON-optimistic — nothing is shown until the server
// confirms the invite exists.
function InviteCard({ ws, onInvited }: { ws: string; onInvited: () => void }): JSX.Element {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const inviteM = useMutation({
    mutationFn: () => inviteMember(ws, email.trim(), role),
    onSuccess: () => { setEmail(''); setRole('editor'); onInvited(); },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    inviteM.mutate();
  };

  return (
    <div className="card">
      <div className="card-h"><h3>Invite a teammate</h3></div>
      <div className="card-b">
        <form onSubmit={submit} className="row wrapf" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 240px', margin: 0 }}>
            <label className="fl">Email</label>
            <input className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" aria-label="Invitee email" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label className="fl">Role</label>
            <select className="inp" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Invite role" style={{ width: 'auto' }}>
              {ROLES.filter((r) => r !== 'owner').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" disabled={!email.trim() || inviteM.isPending}>{inviteM.isPending ? 'Inviting…' : 'Send invite'}</button>
        </form>
        <p className="dim" style={{ fontSize: 12.5, marginTop: 10 }}>{ROLE_BLURB[role]}</p>
        {inviteM.error instanceof ApiError && <div className="hint h-bad" style={{ marginTop: 10 }}>{inviteM.error.displayMessage}</div>}
      </div>
    </div>
  );
}
