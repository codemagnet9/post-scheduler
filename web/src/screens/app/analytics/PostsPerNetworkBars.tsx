// src/screens/app/analytics/PostsPerNetworkBars.tsx
// Ported from the prototype's barsByNetwork(). Post COUNTS are always real (never "unavailable" — a
// published post either happened or it didn't), so bars never show "—"; a network with no metrics
// support is still counted here and just noted, since this chart isn't about metrics availability.
import type { NetworkPostCount } from '../../../api/types';
import { providerLabel } from './analyticsLogic';

export function PostsPerNetworkBars({ data }: { data: NetworkPostCount[] }): JSX.Element {
  if (!data.length) return <p className="dim" style={{ fontSize: 13 }}>No posts published in this range yet.</p>;
  const max = Math.max(...data.map((d) => d.posts));
  return (
    <div style={{ display: 'grid', gap: 9 }}>
      {data.map((row) => (
        <div className="row" style={{ gap: 12 }} key={row.provider}>
          <span style={{ width: 88, fontSize: 12.5, color: 'var(--ink-2)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{providerLabel(row.provider)}</span>
          <span style={{ flex: 1, height: 14, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${max ? (row.posts / max) * 100 : 0}%`, background: 'var(--c2)', borderRadius: '0 4px 4px 0' }} />
          </span>
          <span className="num" style={{ width: 26, textAlign: 'right', fontSize: 12.5, fontWeight: 600 }}>{row.posts}</span>
          {!row.metricsSupported && <span className="dim" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>no metrics</span>}
        </div>
      ))}
    </div>
  );
}
