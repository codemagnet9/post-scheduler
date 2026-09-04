// src/screens/app/settings/NotificationsTab.tsx
// The per-event / per-channel notification matrix, persisted through the Phase 8 preferences API (own
// preferences only; the server enforces that). NON-OPTIMISTIC: a toggle reflects the server's value —
// on change we send the write and refetch; the cell is disabled until it lands, so what you see is
// always what the server has, never an assumed flip.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getNotificationPreferences, setNotificationPreference, getWorkspaceDetail } from '../../../api/endpoints';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { ApiError } from '../../../api/client';
import { ErrorState, SkeletonRows } from '../../../components/states';
import type { NotificationChannel } from '../../../api/types';

const CHANNELS: { key: NotificationChannel; label: string }[] = [
  { key: 'in_app', label: 'In-app' },
  { key: 'email', label: 'Email' },
  { key: 'slack', label: 'Slack' },
];

const EVENT_LABEL: Record<string, string> = {
  publish_failed: 'A post failed to publish',
  account_reconnect: 'An account needs reconnecting',
  needs_approval: 'A post needs my approval',
  post_approved: 'My post was approved',
  post_changes_requested: 'Changes were requested on my post',
  queue_low: 'A queue is running low',
  weekly_summary: 'Weekly summary',
  mention: 'I was mentioned in a comment',
};

export function NotificationsTab(): JSX.Element {
  const { active } = useWorkspace();
  const ws = active.id;
  const qc = useQueryClient();
  const prefsQ = useQuery({ queryKey: ['notif-prefs', ws], queryFn: () => getNotificationPreferences(ws) });
  // Slack delivery is gated on a configured workspace webhook. Until one is set, the Slack column is
  // disabled — a user can't switch on delivery to a channel that would go nowhere.
  const detailQ = useQuery({ queryKey: ['workspace-detail', ws], queryFn: () => getWorkspaceDetail(ws) });
  const slackConfigured = Boolean(detailQ.data?.settings?.slackWebhookUrl);
  const [pending, setPending] = useState<string | null>(null);

  const setM = useMutation({
    mutationFn: ({ event, channel, enabled }: { event: string; channel: NotificationChannel; enabled: boolean }) =>
      setNotificationPreference(ws, event, channel, enabled),
    onMutate: ({ event, channel }) => setPending(`${event}:${channel}`),
    onSettled: () => { setPending(null); qc.invalidateQueries({ queryKey: ['notif-prefs', ws] }); },
  });

  const rows = prefsQ.data ?? [];

  return (
    <div className="card">
      <div className="card-h"><h3>Notifications</h3><span className="dim sp" style={{ fontSize: 12 }}>Applies to you across this workspace</span></div>
      <div className="card-b flush">
        {prefsQ.isLoading ? <div style={{ padding: 20 }}><SkeletonRows rows={5} /></div>
          : prefsQ.error ? <div style={{ padding: 20 }}><ErrorState error={prefsQ.error instanceof ApiError ? prefsQ.error : null} onRetry={() => prefsQ.refetch()} /></div>
          : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    {CHANNELS.map((c) => <th key={c.key} style={{ textAlign: 'center' }}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.event}>
                      <td style={{ fontSize: 13.5 }}>{EVENT_LABEL[row.event] ?? row.event}</td>
                      {CHANNELS.map((c) => {
                        const on = row.channels[c.key];
                        const key = `${row.event}:${c.key}`;
                        const gated = c.key === 'slack' && !slackConfigured;
                        return (
                          <td key={c.key} style={{ textAlign: 'center' }}>
                            <button
                              type="button"
                              className="tog"
                              aria-pressed={gated ? false : on}
                              aria-label={`${EVENT_LABEL[row.event] ?? row.event} — ${c.label}${gated ? ' (configure Slack to enable)' : ''}`}
                              disabled={gated || pending === key}
                              title={gated ? 'Configure a Slack webhook to enable' : undefined}
                              onClick={() => { if (!gated) setM.mutate({ event: row.event, channel: c.key, enabled: !on }); }}
                              style={{ margin: '0 auto', opacity: gated ? 0.4 : 1 }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {setM.error instanceof ApiError && <div className="hint h-bad" style={{ margin: 16 }}>{setM.error.displayMessage}</div>}
        {!slackConfigured && !detailQ.isLoading && (
          <p className="dim" style={{ fontSize: 12.5, margin: 16 }}>
            <strong>Slack</strong> is off until a workspace Slack webhook is configured — otherwise these alerts would go nowhere. Webhook setup is coming soon.
          </p>
        )}
      </div>
    </div>
  );
}
