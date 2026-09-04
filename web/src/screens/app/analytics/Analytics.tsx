// src/screens/app/analytics/Analytics.tsx
// The analytics dashboard container. Every number rendered on this screen comes from ONE API call
// (getAnalytics) plus the glossary call — nothing here sums, divides, or resolves a schedule; it only
// picks a range (in the WORKSPACE zone), requests the dashboard for it, and renders exactly what comes
// back, with a loading/empty/error state for every container.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../../shell/Screen';
import { useWorkspace } from '../../../workspace/WorkspaceProvider';
import { getAnalytics, getMetricsGlossary } from '../../../api/endpoints';
import { ApiError } from '../../../api/client';
import { ErrorState, SkeletonStats, SkeletonRows } from '../../../components/states';
import { ymdInZone, zoneAbbrev } from '../../../lib/datetime';
import { presetRange, buildSeries, daysBetween, type RangePreset } from './analyticsLogic';
import { RangePicker } from './RangePicker';
import { Headline } from './Headline';
import { LineChart } from './LineChart';
import { PostsPerNetworkBars } from './PostsPerNetworkBars';
import { Heatmap } from './Heatmap';
import { TopPostsTable } from './TopPostsTable';
import { MetricsGlossary } from './MetricsGlossary';
import { ExportPanel } from './ExportPanel';

type Metric = 'engagements' | 'impressions';

export function Analytics(): JSX.Element {
  const { active, timezone } = useWorkspace();
  const ws = active.id;
  // "Today" in the WORKSPACE zone, computed once per zone — every preset is built from this, never
  // from the browser's own notion of today.
  const todayYMD = useMemo(() => ymdInZone(new Date(), timezone), [timezone]);

  const [preset, setPreset] = useState<RangePreset | 'custom'>('30d');
  const [custom, setCustom] = useState(() => presetRange('30d', todayYMD));
  const [metric, setMetric] = useState<Metric>('engagements');

  const range = preset === 'custom' ? custom : presetRange(preset, todayYMD);

  const dashboardQ = useQuery({
    queryKey: ['analytics', ws, range.from, range.to, timezone],
    queryFn: () => getAnalytics(ws, { from: range.from, to: range.to, tz: timezone }),
  });
  const glossaryQ = useQuery({ queryKey: ['analytics-glossary', ws], queryFn: () => getMetricsGlossary(ws) });

  const data = dashboardQ.data;
  // The chart's x-axis is derived from the SERVER's resolved range/zone (data.range, data.timezone),
  // not re-computed independently on the client — one source of truth for what the range actually was.
  const days = data ? daysBetween(ymdInZone(data.range.from, data.timezone), ymdInZone(data.range.to, data.timezone)) : [];
  const series = data ? buildSeries(data.dailySeriesByNetwork, data.postsPerNetwork, metric) : { lines: [], legend: [] };

  const rangeLabel = preset === 'custom' ? 'Custom range' : `Last ${preset}`;

  const actions = (
    <>
      <span className="dim" style={{ fontSize: 12, marginRight: 2 }}>Showing {zoneAbbrev(timezone)}</span>
      <RangePicker preset={preset} custom={custom} onPreset={setPreset} onCustom={(c) => { setCustom(c); setPreset('custom'); }} />
      <ExportPanel ws={ws} from={range.from} to={range.to} tz={timezone} />
    </>
  );

  return (
    <Screen title="Analytics" actions={actions}>
      {dashboardQ.isLoading ? <SkeletonStats />
        : dashboardQ.error ? <div className="card"><ErrorState error={dashboardQ.error instanceof ApiError ? dashboardQ.error : null} onRetry={() => dashboardQ.refetch()} /></div>
        : data && <Headline data={data.headline} />}

      <div className="card">
        <div className="card-h">
          <h3>Daily {metric} by network</h3>
          <span className="sp row" style={{ marginLeft: 'auto', gap: 9 }}>
            <div className="seg">
              <button type="button" className={metric === 'engagements' ? 'on' : ''} onClick={() => setMetric('engagements')}>Engagements</button>
              <button type="button" className={metric === 'impressions' ? 'on' : ''} onClick={() => setMetric('impressions')}>Impressions</button>
            </div>
          </span>
        </div>
        <div className="card-b">
          {dashboardQ.isLoading ? <SkeletonRows rows={3} />
            : dashboardQ.error ? <ErrorState error={dashboardQ.error instanceof ApiError ? dashboardQ.error : null} onRetry={() => dashboardQ.refetch()} />
            : <LineChart lines={series.lines} legend={series.legend} days={days} metricLabel={metric} />}
        </div>
      </div>

      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-h"><h3>Posts published by network</h3><span className="dim sp" style={{ fontSize: 12 }}>{rangeLabel}</span></div>
          <div className="card-b">
            {dashboardQ.isLoading ? <SkeletonRows rows={4} />
              : dashboardQ.error ? <ErrorState error={dashboardQ.error instanceof ApiError ? dashboardQ.error : null} onRetry={() => dashboardQ.refetch()} />
              : data && <PostsPerNetworkBars data={data.postsPerNetwork} />}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>When your audience shows up</h3><span className="dim sp" style={{ fontSize: 12 }}>{zoneAbbrev(timezone)}</span></div>
          <div className="card-b">
            {dashboardQ.isLoading ? <SkeletonRows rows={4} />
              : dashboardQ.error ? <ErrorState error={dashboardQ.error instanceof ApiError ? dashboardQ.error : null} onRetry={() => dashboardQ.refetch()} />
              : data && <Heatmap data={data.engagementHeatmap} />}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Top posts</h3><span className="dim sp" style={{ fontSize: 12 }}>{rangeLabel}</span></div>
        <div className="card-b flush">
          {dashboardQ.isLoading ? <SkeletonRows rows={5} />
            : dashboardQ.error ? <ErrorState error={dashboardQ.error instanceof ApiError ? dashboardQ.error : null} onRetry={() => dashboardQ.refetch()} />
            : data && <TopPostsTable data={data.topPosts} />}
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>How metrics are counted</h3></div>
        <div className="card-b">
          {glossaryQ.isLoading ? <SkeletonRows rows={2} />
            : glossaryQ.error ? <ErrorState error={glossaryQ.error instanceof ApiError ? glossaryQ.error : null} onRetry={() => glossaryQ.refetch()} />
            : <MetricsGlossary data={glossaryQ.data ?? []} />}
        </div>
      </div>
    </Screen>
  );
}
