// src/shell/NotificationsBell.tsx
// The top-bar notifications dropdown — a shell panel, not a page. It consumes the Phase 8 in_app
// channel: unread count, mark-as-read, and a deep link that navigates to exactly the thing the
// notification is about (a post opens in the composer, a low queue opens the queue). Times render in the
// workspace zone like everything else.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listNotifications, markNotificationRead } from '../api/endpoints';
import { useWorkspace, useZonedFormat } from '../workspace/WorkspaceProvider';
import { resolveDeepLink } from '../lib/deepLink';
import type { Notification } from '../api/types';

export function NotificationsBell(): JSX.Element {
  const { active } = useWorkspace();
  const ws = active.id;
  const fmt = useZonedFormat();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const notifsQ = useQuery({ queryKey: ['notifications', ws], queryFn: () => listNotifications(ws) });
  const notifs = notifsQ.data ?? [];
  const unread = notifs.filter((n) => !n.read_at).length;

  const readM = useMutation({
    mutationFn: (id: string) => markNotificationRead(ws, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications', ws] }),
  });

  const openNotification = (n: Notification) => {
    if (!n.read_at) readM.mutate(n.id);
    setOpen(false);
    const target = resolveDeepLink(n.deep_link);
    navigate(target.to);
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="btn btn-ghost btn-sm"
        style={{ position: 'relative', padding: '8px 12px' }}
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
      >
        <span aria-hidden>◔</span> Alerts
        {unread > 0 && (
          <span
            className="badge b-bad"
            style={{ position: 'absolute', top: -6, right: -6, padding: '1px 6px', fontSize: 10.5, minWidth: 18, justifyContent: 'center' }}
          >
            {unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={() => setOpen(false)} />
          <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 8, zIndex: 61, width: 360, maxWidth: '90vw', background: 'var(--bg)', borderRadius: 16, boxShadow: '0 18px 48px -16px rgba(25,25,23,.32)', overflow: 'hidden' }}>
            <div className="row" style={{ padding: '13px 16px', borderBottom: '1px solid var(--line-soft)' }}>
              <strong style={{ fontSize: 14 }}>Notifications</strong>
              {unread > 0 && <span className="badge b-bad sp">{unread} unread</span>}
            </div>
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {notifsQ.isLoading ? (
                <p className="dim" style={{ padding: 16, fontSize: 13 }}>Loading…</p>
              ) : notifs.length === 0 ? (
                <p className="dim" style={{ padding: 20, fontSize: 13, textAlign: 'center' }}>You’re all caught up.</p>
              ) : (
                notifs.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => openNotification(n)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--line-soft)', background: n.read_at ? 'transparent' : 'var(--brand-wash)', padding: '12px 16px', cursor: 'pointer' }}
                  >
                    <div className="row" style={{ gap: 8 }}>
                      {!n.read_at && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--brand)', flex: 'none' }} />}
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{n.title}</span>
                      <span className="dim mono sp" style={{ fontSize: 10.5 }}>{fmt.dateTime(n.created_at)}</span>
                    </div>
                    {n.body && <p className="dim" style={{ fontSize: 12.5, margin: '4px 0 0', paddingLeft: n.read_at ? 0 : 15 }}>{n.body}</p>}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
