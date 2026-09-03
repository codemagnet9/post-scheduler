// src/screens/app/Home.tsx
// The landing screen: real data from the summary + accounts endpoints, with loading (skeleton),
// empty and error states for each container. Historical/analytics tiles (sparklines, "going out next")
// need endpoints that arrive in a later phase, so they aren't faked here.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Screen } from '../../shell/Screen';
import { getSummary, listAccounts } from '../../api/endpoints';
import type { Account } from '../../api/types';
import { useWorkspace } from '../../workspace/WorkspaceProvider';
import { Avatar } from '../../components/Avatar';
import { EmptyState, ErrorState, SkeletonRows, SkeletonStats } from '../../components/states';
import { ApiError } from '../../api/client';

const asApiError = (e: unknown): ApiError | null => (e instanceof ApiError ? e : null);

export function Home(): JSX.Element {
  const { active } = useWorkspace();
  const summaryQ = useQuery({ queryKey: ['summary', active.id], queryFn: () => getSummary(active.id) });
  const accountsQ = useQuery({ queryKey: ['accounts', active.id], queryFn: () => listAccounts(active.id) });
  const s = summaryQ.data;

  return (
    <Screen title="Home">
      {/* failure banner — only when something actually failed */}
      {s && s.failed > 0 && (
        <div className="hint h-bad" style={{ alignItems: 'center' }}>
          <span style={{ fontSize: 15 }}>!</span>
          <span><b>{s.failed} {s.failed === 1 ? 'post' : 'posts'} failed to publish.</b> Open the queue to see why and retry — the {s.failed === 1 ? 'post is' : 'posts are'} still there.</span>
          <span className="row" style={{ marginLeft: 'auto' }}><Link className="btn btn-primary btn-sm" to="/queue">Review</Link></span>
        </div>
      )}

      {/* headline figures */}
      {summaryQ.isLoading ? <SkeletonStats />
        : summaryQ.error ? <ErrorState error={asApiError(summaryQ.error)} onRetry={() => summaryQ.refetch()} />
        : s && (
          <div className="grid g4">
            <Stat label="Scheduled" value={s.queue} sub="in the queue" />
            <Stat label="Awaiting approval" value={s.approvals} sub={s.approvals ? 'waiting on a reviewer' : 'nothing to review'} />
            <Stat label="Connected accounts" value={s.networks} sub={s.needsReconnect ? `${s.needsReconnect} need reconnecting` : 'all healthy'} tone={s.needsReconnect ? 'down' : undefined} />
            <Stat label="Failed publishes" value={s.failed} sub={s.failed ? 'needs a retry' : 'all clear'} tone={s.failed ? 'down' : undefined} />
          </div>
        )}

      <div className="grid g-2-1">
        {/* connection health */}
        <div className="card">
          <div className="card-h"><h3>Connection health</h3><Link className="btn btn-quiet btn-sm sp" to="/networks">Manage</Link></div>
          <div className="card-b">
            {accountsQ.isLoading ? <SkeletonRows rows={3} />
              : accountsQ.error ? <ErrorState error={asApiError(accountsQ.error)} onRetry={() => accountsQ.refetch()} />
              : <ConnectionHealth accounts={accountsQ.data ?? []} />}
          </div>
        </div>

        {/* waiting on you */}
        <div className="card">
          <div className="card-h"><h3>Waiting on you</h3>{s ? <span className="badge b-info sp">{s.approvals}</span> : null}</div>
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {s && s.approvals > 0
              ? <><p className="dim" style={{ fontSize: 13.5 }}>{s.approvals} {s.approvals === 1 ? 'post is' : 'posts are'} waiting for your review.</p><Link className="btn btn-ghost btn-sm" to="/approvals" style={{ alignSelf: 'flex-start' }}>Review {s.approvals}</Link></>
              : <p className="dim" style={{ fontSize: 13.5 }}>Nothing needs your approval right now.</p>}
          </div>
        </div>
      </div>
    </Screen>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: 'up' | 'down' }): JSX.Element {
  return (
    <div className="stat">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      <div className={`d${tone ? ` ${tone}` : ''}`} style={tone ? undefined : { color: 'var(--ink-dim)' }}>{sub}</div>
    </div>
  );
}

function ConnectionHealth({ accounts }: { accounts: Account[] }): JSX.Element {
  if (!accounts.length) {
    return <EmptyState icon="◈" title="No accounts connected" description="Connect the networks your brand posts to and Meridian keeps the tokens fresh." actions={<Link className="btn btn-primary btn-sm" to="/networks">Connect an account</Link>} />;
  }
  const healthy = accounts.filter((a) => a.status === 'active').length;
  const needs = accounts.filter((a) => a.status !== 'active');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      <div className="row">
        <span className="badge b-ok"><span className="d" />{healthy} healthy</span>
        {needs.length > 0 && <span className="badge b-bad"><span className="d" />{needs.length} need attention</span>}
      </div>
      {needs.map((a) => (
        <div key={a.id} className="row" style={{ gap: 10 }}>
          <Avatar name={a.handle ?? a.provider} seed={a.id} size={28} square />
          <span>
            <span style={{ fontWeight: 600, fontSize: 13, display: 'block', lineHeight: 1.2 }}>{a.handle ?? a.display_name ?? a.provider}</span>
            <span className="dim" style={{ fontSize: 11.5 }}>{a.status === 'auth_expired' ? 'Reconnect required' : a.status.replace('_', ' ')}</span>
          </span>
          <Link className="btn btn-ghost btn-sm" to="/networks" style={{ marginLeft: 'auto' }}>Reconnect</Link>
        </div>
      ))}
      {needs.length === 0 && <div className="hint h-info" style={{ marginTop: 2 }}>✓ <span>Every account is connected. Meridian refreshes tokens on its own.</span></div>}
    </div>
  );
}
