// src/screens/app/networks/Networks.tsx
// Connected accounts against real OAuth. Each account shows its health (status conveyed by icon+label,
// never colour alone), when it last published, how many posts still depend on it, and the network's
// capability notes read live from the descriptor. Connect starts the real handshake; reconnect re-auths
// the same row so scheduled posts survive; disconnect requires a typed confirmation and says what will
// happen to queued work. A "coming soon" section names the partner-gated networks and what's blocking
// them — honesty that stops customers asking where LinkedIn is.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../../shell/Screen';
import { useWorkspace, useZonedFormat } from '../../../workspace/WorkspaceProvider';
import { getAccountHealth, getProviderCatalog } from '../../../api/endpoints';
import { ApiError } from '../../../api/client';
import { EmptyState, ErrorState, SkeletonRows } from '../../../components/states';
import { Avatar } from '../../../components/Avatar';
import { statusView } from '../../../lib/accountStatus';
import { ConnectModal } from './ConnectModal';
import { DisconnectModal } from './DisconnectModal';
import type { AccountHealth } from '../../../api/types';

export function Networks(): JSX.Element {
  const { active } = useWorkspace();
  const ws = active.id;
  const fmt = useZonedFormat();
  const [connecting, setConnecting] = useState<null | { kind: 'pick' } | { kind: 'reconnect'; provider: string; displayName: string }>(null);
  const [disconnecting, setDisconnecting] = useState<AccountHealth | null>(null);

  const healthQ = useQuery({ queryKey: ['account-health', ws], queryFn: () => getAccountHealth(ws) });
  const catalogQ = useQuery({ queryKey: ['provider-catalog', ws], queryFn: () => getProviderCatalog(ws) });

  const accounts = healthQ.data ?? [];
  const catalog = catalogQ.data;

  const actions = <button className="btn btn-primary" onClick={() => setConnecting({ kind: 'pick' })}>Connect a network</button>;

  return (
    <Screen title="Networks" actions={actions}>
      {/* connected accounts */}
      <div className="card">
        <div className="card-h"><h3>Connected accounts</h3>{accounts.length > 0 && <span className="dim sp" style={{ fontSize: 12 }}>{accounts.length}</span>}</div>
        <div className="card-b flush">
          {healthQ.isLoading ? <div style={{ padding: 20 }}><SkeletonRows rows={3} /></div>
            : healthQ.error ? <div style={{ padding: 20 }}><ErrorState error={healthQ.error instanceof ApiError ? healthQ.error : null} onRetry={() => healthQ.refetch()} /></div>
            : accounts.length === 0 ? (
              <div style={{ padding: 8 }}>
                <EmptyState
                  icon="◈"
                  title="No networks connected yet"
                  description="Connect the accounts your brand posts to. Meridian keeps their tokens fresh so your schedule keeps running."
                  actions={<button className="btn btn-primary btn-sm" onClick={() => setConnecting({ kind: 'pick' })}>Connect your first network</button>}
                />
              </div>
            ) : (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr><th>Account</th><th>Status</th><th>Last published</th><th>Capabilities</th><th aria-label="actions" /></tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => {
                      const sv = statusView(a.status);
                      const name = a.handle ?? a.displayName ?? a.provider;
                      return (
                        <tr key={a.id}>
                          <td>
                            <div className="row" style={{ gap: 10 }}>
                              <Avatar name={name} seed={a.id} size={34} square />
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{name}</div>
                                <div className="dim" style={{ fontSize: 12, textTransform: 'capitalize' }}>{a.provider} · {a.timezone.replace(/_/g, ' ')}</div>
                              </div>
                            </div>
                          </td>
                          <td>
                            {/* icon + label — status is never colour-only */}
                            <span className={`badge ${sv.badge}`} title={sv.detail}><span aria-hidden>{sv.icon}</span> {sv.label}</span>
                            {a.queuedCount > 0 && <div className="dim" style={{ fontSize: 11.5, marginTop: 5 }}>{a.queuedCount} queued</div>}
                          </td>
                          <td className="dim" style={{ fontSize: 12.5 }}>{a.lastPublishedAt ? fmt.dateTime(a.lastPublishedAt) : 'Never'}</td>
                          <td style={{ fontSize: 12 }}>
                            {a.capabilities ? (
                              <span className="dim">{a.capabilities.surface}. {a.capabilities.threads}. {a.capabilities.firstComment ? 'First comment supported.' : 'No first comment.'}</span>
                            ) : <span className="dim">—</span>}
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {sv.actionable && (
                              <button className="btn btn-ghost btn-sm" style={{ marginRight: 8 }}
                                onClick={() => setConnecting({ kind: 'reconnect', provider: a.provider, displayName: name })}>
                                Reconnect
                              </button>
                            )}
                            <button className="btn btn-danger btn-sm" onClick={() => setDisconnecting(a)}>Disconnect</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>

      {/* coming soon — partner-gated networks, with the honest blocker */}
      <div className="card">
        <div className="card-h"><h3>Coming soon</h3><span className="dim sp" style={{ fontSize: 12 }}>Gated on partner approval</span></div>
        <div className="card-b">
          {catalogQ.isLoading ? <SkeletonRows rows={3} />
            : (catalog?.comingSoon ?? []).map((c) => (
              <div key={c.name} className="row" style={{ gap: 12, alignItems: 'flex-start', padding: '11px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <span aria-hidden style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--surface-2)', color: 'var(--ink-dim)', display: 'grid', placeItems: 'center', flex: 'none' }}>◷</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</div>
                  <div className="dim" style={{ fontSize: 12.5 }}>{c.blockedOn}</div>
                </div>
                <span className="badge b-mute">Awaiting approval</span>
              </div>
            ))}
          <p className="dim" style={{ fontSize: 12.5, marginTop: 12 }}>These publish directly once we clear each platform’s review. We’d rather show you the real status than hide the gap.</p>
        </div>
      </div>

      {connecting && catalog && <ConnectModal catalog={catalog.available} mode={connecting} onClose={() => setConnecting(null)} />}
      {disconnecting && <DisconnectModal account={disconnecting} onClose={() => setDisconnecting(null)} />}
    </Screen>
  );
}
