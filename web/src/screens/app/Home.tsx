// src/screens/app/Home.tsx
// The daily dashboard, wired to real data. The engagement tiles come from the SAME analytics endpoint
// the Analytics screen uses (so every number matches its source of truth); "Next 48 hours" comes from
// the calendar/queue; "Needs your attention" merges approvals, failed publishes and accounts needing a
// reconnect. Every figure links to the screen that owns it. A first-time account sees a "Finish setup"
// card and honest empty states — never a faked number.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Screen } from '../../shell/Screen';
import { getSummary, getAnalytics, listCalendar, getAccountHealth } from '../../api/endpoints';
import { useWorkspace, useZonedFormat } from '../../workspace/WorkspaceProvider';
import { ApiError } from '../../api/client';
import { EmptyState, ErrorState, SkeletonRows, SkeletonStats } from '../../components/states';
import { Avatar } from '../../components/Avatar';
import { ymdInZone, zoneAbbrev } from '../../lib/datetime';
import { presetRange, formatCompact, formatPercent, providerLabel } from './analytics/analyticsLogic';
import { statusView } from '../../lib/accountStatus';
import { FinishSetupCard } from './setup/SetupGuide';

const asApiError = (e: unknown): ApiError | null => (e instanceof ApiError ? e : null);

export function Home(): JSX.Element {
  const { active, timezone } = useWorkspace();
  const ws = active.id;
  const fmt = useZonedFormat();

  const todayYMD = useMemo(() => ymdInZone(new Date(), timezone), [timezone]);
  const range = useMemo(() => presetRange('30d', todayYMD), [todayYMD]);
  // The 48-hour window, as instants — the calendar query bounds are compared against real timestamps.
  const window48 = useMemo(() => ({ from: new Date().toISOString(), to: new Date(Date.now() + 48 * 3600_000).toISOString() }), []);

  const summaryQ = useQuery({ queryKey: ['summary', ws], queryFn: () => getSummary(ws) });
  const analyticsQ = useQuery({ queryKey: ['analytics', ws, range.from, range.to, timezone], queryFn: () => getAnalytics(ws, { from: range.from, to: range.to, tz: timezone }) });
  const upcomingQ = useQuery({ queryKey: ['home-upcoming', ws], queryFn: () => listCalendar(ws, window48.from, window48.to) });
  const accountsQ = useQuery({ queryKey: ['account-health', ws], queryFn: () => getAccountHealth(ws) });

  const s = summaryQ.data;
  const h = analyticsQ.data?.headline;
  const postsPublished = (analyticsQ.data?.postsPerNetwork ?? []).reduce((acc, n) => acc + n.posts, 0);
  const upcoming = (upcomingQ.data ?? [])
    .filter((e) => e.state === 'scheduled' || e.state === 'publishing')
    .sort((a, b) => (a.instant ?? '').localeCompare(b.instant ?? ''))
    .slice(0, 6);
  const needsReconnect = (accountsQ.data ?? []).filter((a) => statusView(a.status).actionable);

  return (
    <Screen title="Home">
      <FinishSetupCard />

      {/* failure banner — only when something actually failed */}
      {s && s.failed > 0 && (
        <div className="hint h-bad" style={{ alignItems: 'center' }}>
          <span aria-hidden style={{ fontSize: 15 }}>!</span>
          <span><b>{s.failed} {s.failed === 1 ? 'post' : 'posts'} failed to publish.</b> Open the queue to see why and retry — {s.failed === 1 ? "it's" : "they're"} still there.</span>
          <span className="row" style={{ marginLeft: 'auto' }}><Link className="btn btn-primary btn-sm" to="/queue">Review</Link></span>
        </div>
      )}

      {/* engagement summary — last 30 days, from the analytics source of truth */}
      <div className="card">
        <div className="card-h">
          <h3>Last 30 days</h3>
          <span className="dim sp row" style={{ fontSize: 12, gap: 10 }}>Showing {zoneAbbrev(timezone)} <Link className="btn btn-quiet btn-sm" to="/analytics">Open analytics</Link></span>
        </div>
        <div className="card-b">
          {analyticsQ.isLoading ? <SkeletonStats />
            : analyticsQ.error ? <ErrorState error={asApiError(analyticsQ.error)} onRetry={() => analyticsQ.refetch()} />
            : (
              <div className="grid g4">
                <Stat label="Impressions" value={formatCompact(h?.impressions.value ?? null)} sub="across all networks" />
                <Stat label="Engagements" value={formatCompact(h?.engagements.value ?? null)} sub="likes, replies, reposts" />
                <Stat label="Engagement rate" value={formatPercent(h?.engagementRate.value ?? null)} sub="engagements ÷ impressions" />
                <Stat label="Link clicks" value={formatCompact(h?.linkClicks.value ?? null)} sub="where reported" />
                <Stat label="Posts published" value={String(postsPublished)} sub="in the last 30 days" />
                <Stat label="Connected accounts" value={String(s?.networks ?? '—')} sub={s?.needsReconnect ? `${s.needsReconnect} need reconnecting` : 'all healthy'} tone={s?.needsReconnect ? 'down' : undefined} />
              </div>
            )}
        </div>
      </div>

      <div className="grid g2" style={{ alignItems: 'start' }}>
        {/* next 48 hours */}
        <div className="card">
          <div className="card-h"><h3>Next 48 hours</h3><Link className="btn btn-quiet btn-sm sp" to="/queue">Queue</Link></div>
          <div className="card-b flush">
            {upcomingQ.isLoading ? <div style={{ padding: 16 }}><SkeletonRows rows={4} /></div>
              : upcomingQ.error ? <div style={{ padding: 16 }}><ErrorState error={asApiError(upcomingQ.error)} onRetry={() => upcomingQ.refetch()} /></div>
              : upcoming.length === 0 ? (
                <div style={{ padding: 8 }}><EmptyState icon="≡" title="Nothing scheduled" description="Your next two days are clear. Compose a post to fill the queue."
                  actions={<Link className="btn btn-primary btn-sm" to="/composer">Compose a post</Link>} /></div>
              ) : (
                <div>
                  {upcoming.map((e) => (
                    <div key={e.targetId} className="row" style={{ gap: 11, padding: '13px 16px', borderBottom: '1px solid var(--line-soft)' }}>
                      <Avatar name={e.handle ?? e.provider} seed={e.targetId} size={30} square />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.text || <span className="dim">No caption</span>}</div>
                        <div className="dim" style={{ fontSize: 11.5 }}>{providerLabel(e.provider)} · {e.handle ?? ''}</div>
                      </div>
                      <div className="mono dim" style={{ fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {e.instant ? <>{fmt.dateTime(e.instant)}<br /><span style={{ fontSize: 10 }}>{zoneAbbrev(e.timezone)}</span></> : '—'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>

        {/* needs your attention */}
        <div className="card">
          <div className="card-h"><h3>Needs your attention</h3></div>
          <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {summaryQ.isLoading || accountsQ.isLoading ? <SkeletonRows rows={3} />
              : (
                <AttentionList
                  approvals={s?.approvals ?? 0}
                  failed={s?.failed ?? 0}
                  reconnect={needsReconnect.map((a) => ({ id: a.id, name: a.handle ?? a.displayName ?? a.provider, status: a.status }))}
                />
              )}
          </div>
        </div>
      </div>
    </Screen>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'up' | 'down' }): JSX.Element {
  return (
    <div className="stat">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      <div className={`d${tone ? ` ${tone}` : ''}`} style={tone ? undefined : { color: 'var(--ink-dim)' }}>{sub}</div>
    </div>
  );
}

function AttentionList({ approvals, failed, reconnect }: { approvals: number; failed: number; reconnect: { id: string; name: string; status: string }[] }): JSX.Element {
  const rows: JSX.Element[] = [];
  if (approvals > 0) rows.push(
    <AttentionRow key="approvals" icon="✓" tone="b-info" text={`${approvals} ${approvals === 1 ? 'post is' : 'posts are'} waiting for review`} to="/approvals" cta="Review" />,
  );
  if (failed > 0) rows.push(
    <AttentionRow key="failed" icon="!" tone="b-bad" text={`${failed} ${failed === 1 ? 'publish' : 'publishes'} failed`} to="/queue" cta="Retry" />,
  );
  for (const a of reconnect) {
    const sv = statusView(a.status);
    rows.push(<AttentionRow key={a.id} icon={sv.icon} tone={sv.badge} text={`${a.name} — ${sv.label.toLowerCase()}`} to="/networks" cta="Reconnect" />);
  }
  if (rows.length === 0) {
    return <EmptyState icon="✓" title="You're all caught up" description="No approvals, failures, or accounts needing attention." />;
  }
  return <>{rows}</>;
}

function AttentionRow({ icon, tone, text, to, cta }: { icon: string; tone: string; text: string; to: string; cta: string }): JSX.Element {
  return (
    <div className="row" style={{ gap: 11 }}>
      <span className={`badge ${tone}`} style={{ flex: 'none' }}><span aria-hidden>{icon}</span></span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>{text}</span>
      <Link className="btn btn-ghost btn-sm" to={to}>{cta}</Link>
    </div>
  );
}
