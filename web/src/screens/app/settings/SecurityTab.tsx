// src/screens/app/settings/SecurityTab.tsx
// Active sessions for the signed-in user, with revoke. Sessions belong to the user (not the workspace),
// so this is the same list on every workspace. Revoking your CURRENT session signs you out here — it's
// labelled so that's a deliberate choice, not a surprise.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listSessions, revokeSession } from '../../../api/endpoints';
import { useAuth } from '../../../auth/AuthProvider';
import { useZonedFormat } from '../../../workspace/WorkspaceProvider';
import { ApiError } from '../../../api/client';
import { EmptyState, ErrorState, SkeletonRows } from '../../../components/states';

function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent;
  const browser = /Edg/.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function SecurityTab(): JSX.Element {
  const { logout } = useAuth();
  const fmt = useZonedFormat();
  const qc = useQueryClient();
  const sessionsQ = useQuery({ queryKey: ['sessions'], queryFn: () => listSessions() });

  const revokeM = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: async (_r, id) => {
      const wasCurrent = sessionsQ.data?.find((s) => s.id === id)?.current;
      if (wasCurrent) { await logout(); return; } // revoking your own current session = sign out
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const sessions = sessionsQ.data ?? [];

  return (
    <div className="card">
      <div className="card-h"><h3>Active sessions</h3><span className="dim sp" style={{ fontSize: 12 }}>Devices signed in as you</span></div>
      <div className="card-b flush">
        {sessionsQ.isLoading ? <div style={{ padding: 20 }}><SkeletonRows rows={3} /></div>
          : sessionsQ.error ? <div style={{ padding: 20 }}><ErrorState error={sessionsQ.error instanceof ApiError ? sessionsQ.error : null} onRetry={() => sessionsQ.refetch()} /></div>
          : sessions.length === 0 ? <EmptyState icon="⛨" title="No active sessions" />
          : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr><th>Device</th><th>IP</th><th>Last active</th><th>Expires</th><th aria-label="actions" /></tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{deviceLabel(s.userAgent)}{s.current && <span className="badge b-info" style={{ marginLeft: 8 }}>This device</span>}</div>
                      </td>
                      <td className="dim mono" style={{ fontSize: 12.5 }}>{s.ip ?? '—'}</td>
                      <td className="dim" style={{ fontSize: 12.5 }}>{s.lastUsedAt ? fmt.dateTime(s.lastUsedAt) : 'Never'}</td>
                      <td className="dim" style={{ fontSize: 12.5 }}>{fmt.date(s.expiresAt)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-danger btn-sm" disabled={revokeM.isPending} onClick={() => revokeM.mutate(s.id)}>
                          {s.current ? 'Sign out' : 'Revoke'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {revokeM.error instanceof ApiError && <div className="hint h-bad" style={{ margin: 16 }}>{revokeM.error.displayMessage}</div>}
      </div>
    </div>
  );
}
